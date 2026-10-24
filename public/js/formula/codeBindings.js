// Links each identifier in a piece of code to the declaration it refers to, following JavaScript's
// scopes: blocks, functions (including arrow functions), parameters, for heads, catch clauses and
// destructuring. The editor uses it to give each local variable its own highlight and to light up
// a binding's other occurrences on hover.
//
// It's a heuristic over tokens, not a full parser: it only has to be right for the highlighting.
// Known gaps: regex literals, ${} inside template literals, labels and classes aren't recognised.
//
// Also home to the syntax-highlighting token patterns, so the editor's highlighter and this
// tokenizer agree on where every identifier starts.
//
// Everything is private to the CodeBindings closure except the names in its returned object, which
// are also exposed as globals for the other scripts.

const CodeBindings = (() => {

    // --- Tokens -----------------------------------------------------------------------------------
    // Unterminated comments and strings run to the end so typing one doesn't flicker. Numbers
    // include RS shorthand like 10k / 1.5m / 2b.

    const SYNTAX_COMMENT_PATTERN = /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/.source;
    const SYNTAX_STRING_PATTERN = /(?<string>'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|`(?:\\[\s\S]|[^`\\])*`?)/.source;
    const SYNTAX_NUMBER_PATTERN = /(?<number>\b(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?[kmb]?)\b|\.\d+\b)/.source;
    const SYNTAX_IDENT_PATTERN = /(?<ident>[A-Za-z_$][\w$]*)/.source;
    const SYNTAX_OP_PATTERN = /(?<op>=>|[=!<>]=?=?|&&|\|\||\?\?|[-+*\/%&|^~?:]=?|\.\.\.)/.source;
    const SYNTAX_PUNCT_PATTERN = /(?<punct>[{}()\[\];,.])/.source;
    const SYNTAX_KEYWORDS = new Set([
        'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'of', 'in',
        'break', 'continue', 'switch', 'case', 'default', 'new', 'typeof', 'instanceof', 'try',
        'catch', 'finally', 'throw', 'class', 'this', 'delete', 'void', 'async', 'await', 'yield',
    ]);
    const SYNTAX_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

    const TOKEN_TYPES = ['comment', 'string', 'number', 'ident', 'op', 'punct'];

    // The same patterns and flags as the highlighter, so identifiers start at the same offsets.
    const TOKEN_REGEX = new RegExp([
        SYNTAX_COMMENT_PATTERN, SYNTAX_STRING_PATTERN, SYNTAX_NUMBER_PATTERN,
        SYNTAX_IDENT_PATTERN, SYNTAX_OP_PATTERN, SYNTAX_PUNCT_PATTERN,
    ].join('|'), 'gi');

    // The code as [{ type, text, start }], comments left out.
    const tokenize = (code) => {
        const tokens = [];
        for (const match of code.matchAll(TOKEN_REGEX)) {
            const type = TOKEN_TYPES.find(name => match.groups[name] !== undefined);
            if (type !== 'comment') {
                tokens.push({ type, text: match[0], start: match.index });
            }
        }
        return tokens;
    };

    const CLOSER_OF = { '(': ')', '[': ']', '{': '}' };
    const CLOSERS = new Set([')', ']', '}']);

    const isPunct = (token, text) => Boolean(token) && token.type === 'punct' && token.text === text;
    const isOp = (token, text) => Boolean(token) && token.type === 'op' && token.text === text;
    const isWord = (token, text) => Boolean(token) && token.type === 'ident' && token.text === text;
    const isOpener = (token) => Boolean(token) && token.type === 'punct' && token.text in CLOSER_OF;
    const isCloser = (token) => Boolean(token) && token.type === 'punct' && CLOSERS.has(token.text);

    // For each bracket token, the index of its partner; -1 for other tokens and unclosed brackets.
    const matchBrackets = (tokens) => {
        const partner = new Array(tokens.length).fill(-1);
        const open = [];
        for (let i = 0; i < tokens.length; i++) {
            if (isOpener(tokens[i])) {
                open.push(i);
                continue;
            }

            const top = open[open.length - 1];
            const closesTop = isCloser(tokens[i])
                && top !== undefined
                && CLOSER_OF[tokens[top].text] === tokens[i].text;
            if (closesTop) {
                partner[top] = i;
                partner[i] = top;
                open.pop();
            }
        }
        return partner;
    };


    // --- Walk state -------------------------------------------------------------------------------
    // ctx: { tokens, partner, root, frames, occurrences, refs, pendingBody, declaring, nextId }.
    //   frames: the open brackets and expression bodies, innermost last, as
    //     { closer, scope, bodyScope, isExpression }. closer: the index of the token that closes
    //     the frame (-1 when it never does). scope: the scope the frame opens, or null.
    //     bodyScope: for a parameter list or for head, the scope its body continues.
    //     isExpression: an arrow's expression body (or a for's single statement), which has no
    //     bracket of its own and ends at a "," or ";" or the bracket around it.
    //   occurrences: token index -> binding, for every identifier linked to a declaration.
    //   refs: identifiers to resolve once every declaration is known, as { index, scope }.
    //   pendingBody: { scope, at } once a parameter list or for head closes: the token at `at`
    //     starts the body that continues `scope`.
    //   declaring: { target, depth } inside a const / let / var statement, so a "," at `depth`
    //     starts another declarator.

    // scope: { parent, isFunction, bindings: Map name -> binding }.
    const newScope = (parent, isFunction) => ({ parent, isFunction, bindings: new Map() });

    const currentScope = (ctx) => {
        for (let i = ctx.frames.length - 1; i >= 0; i--) {
            if (ctx.frames[i].scope) {
                return ctx.frames[i].scope;
            }
        }
        return ctx.root;
    };

    // Where a var goes: the nearest function's scope, or the top level.
    const functionScope = (ctx) => {
        let scope = currentScope(ctx);
        while (scope !== ctx.root && !scope.isFunction) {
            scope = scope.parent;
        }
        return scope;
    };

    const pushFrame = (ctx, frame) => {
        ctx.frames.push({ closer: -1, scope: null, bodyScope: null, isExpression: false, ...frame });
    };

    // Ends the expression bodies at the top of the stack, e.g. at the "," after `x => x * 2`.
    const closeExpressionFrames = (ctx) => {
        while (ctx.frames.length && ctx.frames[ctx.frames.length - 1].isExpression) {
            ctx.frames.pop();
        }
    };

    // Reuses the binding when a name is declared again in the same scope (var, or a function and
    // a var of the same name), so every occurrence links to the one binding.
    const declareAt = (ctx, index, scope) => {
        const name = ctx.tokens[index].text;
        let binding = scope.bindings.get(name);
        if (!binding) {
            const declaredAt = ctx.tokens[index].start;
            binding = { id: ctx.nextId++, name, isTopLevel: scope === ctx.root, declaredAt };
            scope.bindings.set(name, binding);
        }
        ctx.occurrences.set(index, binding);
    };


    // --- Declarations -----------------------------------------------------------------------------

    // Skips a default value inside a pattern (the `1` in `{ a = 1 }`), up to the "," or closing
    // bracket after it. Returns the index of that token.
    const skipDefaultValue = (ctx, from, to) => {
        let i = from;
        while (i < to) {
            const token = ctx.tokens[i];
            if (isOpener(token) && ctx.partner[i] > i) {
                i = ctx.partner[i] + 1;
                continue;
            }
            if (isPunct(token, ',') || isCloser(token)) {
                return i;
            }
            i++;
        }
        return i;
    };

    // Declares the names a destructuring pattern or parameter list binds, between the brackets at
    // from - 1 and to. A name followed by ":" is a property key (`b` in `{ b: c }`), not a binding.
    const declarePatternRange = (ctx, from, to, scope) => {
        let i = from;
        while (i < to) {
            const token = ctx.tokens[i];
            if (isOp(token, '=')) {
                i = skipDefaultValue(ctx, i + 1, to);
                continue;
            }

            const isName = token.type === 'ident' && !SYNTAX_KEYWORDS.has(token.text);
            const isKey = isOp(ctx.tokens[i + 1], ':');
            if (isName && !isKey) {
                declareAt(ctx, i, scope);
            }
            i++;
        }
    };

    // Declares the binding pattern starting at token `index`: a name, or a { } / [ ] pattern.
    const declarePattern = (ctx, index, scope) => {
        const token = ctx.tokens[index];
        if (!token) {
            return;
        }

        if (token.type === 'ident' && !SYNTAX_KEYWORDS.has(token.text)) {
            declareAt(ctx, index, scope);
            return;
        }
        const isDestructuring = isPunct(token, '{') || isPunct(token, '[');
        if (isDestructuring && ctx.partner[index] > index) {
            declarePatternRange(ctx, index + 1, ctx.partner[index], scope);
        }
    };

    const startDeclaration = (ctx, index) => {
        const isVar = ctx.tokens[index].text === 'var';
        const target = isVar ? functionScope(ctx) : currentScope(ctx);
        ctx.declaring = { target, depth: ctx.frames.length };
        declarePattern(ctx, index + 1, target);
    };

    // `function name(` declares name where it stands.
    const declareFunctionName = (ctx, index) => {
        const name = ctx.tokens[index + 1];
        const isNamed = name && name.type === 'ident' && isPunct(ctx.tokens[index + 2], '(');
        if (isNamed) {
            declareAt(ctx, index + 1, currentScope(ctx));
        }
    };


    // --- Brackets ---------------------------------------------------------------------------------

    // Whether the "(" at index opens a function's parameters: an arrow's `(a, b) =>`, after
    // `function` or `function name`, or a method shorthand `name(a) {` (not `if (x) {`).
    const isParameterList = (ctx, index) => {
        const close = ctx.partner[index];
        if (close === -1) {
            return false;
        }

        const before = ctx.tokens[index - 1];
        const after = ctx.tokens[close + 1];
        if (isOp(after, '=>') || isWord(before, 'function')) {
            return true;
        }

        const isNamedBefore = before && before.type === 'ident' && !SYNTAX_KEYWORDS.has(before.text);
        if (!isNamedBefore) {
            return false;
        }
        return isWord(ctx.tokens[index - 2], 'function') || isPunct(after, '{');
    };

    const openParen = (ctx, index) => {
        const closer = ctx.partner[index];
        const before = ctx.tokens[index - 1];

        if (isWord(before, 'for')) {
            const scope = newScope(currentScope(ctx), false);
            pushFrame(ctx, { closer, scope, bodyScope: scope });
            return;
        }

        const isCatch = isWord(before, 'catch');
        if (isCatch || isParameterList(ctx, index)) {
            const scope = newScope(currentScope(ctx), !isCatch);
            if (closer !== -1) {
                declarePatternRange(ctx, index + 1, closer, scope);
            }
            pushFrame(ctx, { closer, scope, bodyScope: scope });
            return;
        }

        pushFrame(ctx, { closer });
    };

    const openBracket = (ctx, index) => {
        const closer = ctx.partner[index];
        if (ctx.tokens[index].text === '(') {
            openParen(ctx, index);
        } else if (ctx.tokens[index].text === '{') {
            pushFrame(ctx, { closer, scope: newScope(currentScope(ctx), false) });
        } else {
            pushFrame(ctx, { closer });
        }
    };

    // A closing bracket ends any expression bodies inside it, then its own frame. A parameter
    // list or for head leaves its scope pending for the body that follows.
    const closeBracket = (ctx, index) => {
        closeExpressionFrames(ctx);
        const top = ctx.frames[ctx.frames.length - 1];
        if (!top || top.closer !== index) {
            return;
        }

        ctx.frames.pop();
        if (top.bodyScope) {
            ctx.pendingBody = { scope: top.bodyScope, at: index + 1 };
        }
        if (ctx.declaring && ctx.frames.length < ctx.declaring.depth) {
            ctx.declaring = null;
        }
    };

    // The token after a parameter list (or `x =>`) or for head. Returns true when it was consumed.
    // A "{" is the body's own block; anything else starts an expression body.
    const enterPendingBody = (ctx, index) => {
        const token = ctx.tokens[index];
        if (isOp(token, '=>')) {
            ctx.pendingBody.at = index + 1;
            return true;
        }

        const { scope } = ctx.pendingBody;
        ctx.pendingBody = null;
        if (isPunct(token, '{')) {
            pushFrame(ctx, { closer: ctx.partner[index], scope });
            return true;
        }
        pushFrame(ctx, { scope, isExpression: true });
        return false;
    };

    const handleSeparator = (ctx, index) => {
        closeExpressionFrames(ctx);
        const isDeclarationLevel = ctx.declaring && ctx.frames.length === ctx.declaring.depth;
        if (!isDeclarationLevel) {
            return;
        }

        if (ctx.tokens[index].text === ',') {
            declarePattern(ctx, index + 1, ctx.declaring.target);
        } else {
            ctx.declaring = null;
        }
    };


    // --- Identifiers ------------------------------------------------------------------------------

    // Keywords that can't appear inside an arrow's expression body, so seeing one means the body
    // ended without a "," or ";" (e.g. `const f = x => x * 2` followed by a new line).
    const STATEMENT_KEYWORDS = new Set(['const', 'let', 'var', 'return', 'if', 'for', 'while', 'do', 'switch', 'throw', 'try']);

    // A name after "." is a property, and a name before ":" in an object literal is a key.
    const isPropertyName = (ctx, index) => {
        const before = ctx.tokens[index - 1];
        if (isPunct(before, '.')) {
            return true;
        }
        const isKey = isOp(ctx.tokens[index + 1], ':') && (isPunct(before, '{') || isPunct(before, ','));
        return isKey;
    };

    const handleKeyword = (ctx, index) => {
        const word = ctx.tokens[index].text;
        if (STATEMENT_KEYWORDS.has(word)) {
            closeExpressionFrames(ctx);
        }

        if (word === 'const' || word === 'let' || word === 'var') {
            startDeclaration(ctx, index);
        } else if (word === 'function') {
            declareFunctionName(ctx, index);
        }
    };

    const handleIdentifier = (ctx, index) => {
        const token = ctx.tokens[index];
        if (SYNTAX_KEYWORDS.has(token.text)) {
            handleKeyword(ctx, index);
            return;
        }
        const isAlreadyLinked = ctx.occurrences.has(index);
        if (isAlreadyLinked || SYNTAX_LITERALS.has(token.text) || isPropertyName(ctx, index)) {
            return;
        }

        // `x => ...`: a single parameter without parentheses.
        if (isOp(ctx.tokens[index + 1], '=>')) {
            const scope = newScope(currentScope(ctx), true);
            declareAt(ctx, index, scope);
            ctx.pendingBody = { scope, at: index + 1 };
            return;
        }

        ctx.refs.push({ index, scope: currentScope(ctx) });
    };

    const walkToken = (ctx, index) => {
        if (ctx.pendingBody && ctx.pendingBody.at === index && enterPendingBody(ctx, index)) {
            return;
        }

        const token = ctx.tokens[index];
        if (isOpener(token)) {
            openBracket(ctx, index);
        } else if (isCloser(token)) {
            closeBracket(ctx, index);
        } else if (isPunct(token, ',') || isPunct(token, ';')) {
            handleSeparator(ctx, index);
        } else if (token.type === 'ident') {
            handleIdentifier(ctx, index);
        }
    };

    // A reference links to the nearest enclosing declaration of its name, wherever in that scope
    // the declaration is (a function may use a const declared below it).
    const resolveReferences = (ctx) => {
        for (const { index, scope } of ctx.refs) {
            const name = ctx.tokens[index].text;
            for (let s = scope; s; s = s.parent) {
                const binding = s.bindings.get(name);
                if (binding) {
                    ctx.occurrences.set(index, binding);
                    break;
                }
            }
        }
    };


    // --- Public API -------------------------------------------------------------------------------

    /**
     * Every identifier in the code that names a declared binding.
     * @param {string} code
     * @returns {Map<number, {id: number, name: string, isTopLevel: boolean, declaredAt: number}>}
     *   The identifier's offset in the code -> its binding. Occurrences of the same binding share
     *   the object; id is unique per binding. isTopLevel: declared at the top level of the code
     *   (not in a block or function). declaredAt: the offset of its first declaration. Undeclared
     *   names (globals, other scopes' variables) aren't included.
     */
    const findCodeBindings = (code) => {
        const tokens = tokenize(code);
        const ctx = {
            tokens,
            partner: matchBrackets(tokens),
            root: newScope(null, true),
            frames: [],
            occurrences: new Map(),
            refs: [],
            pendingBody: null,
            declaring: null,
            nextId: 1,
        };

        for (let i = 0; i < tokens.length; i++) {
            walkToken(ctx, i);
        }
        resolveReferences(ctx);

        const byOffset = new Map();
        for (const [index, binding] of ctx.occurrences) {
            byOffset.set(tokens[index].start, binding);
        }
        return byOffset;
    };

    return Object.freeze({
        SYNTAX_COMMENT_PATTERN,
        SYNTAX_STRING_PATTERN,
        SYNTAX_NUMBER_PATTERN,
        SYNTAX_IDENT_PATTERN,
        SYNTAX_OP_PATTERN,
        SYNTAX_PUNCT_PATTERN,
        SYNTAX_KEYWORDS,
        SYNTAX_LITERALS,
        findCodeBindings,
    });
})();

const {
    SYNTAX_COMMENT_PATTERN,
    SYNTAX_STRING_PATTERN,
    SYNTAX_NUMBER_PATTERN,
    SYNTAX_IDENT_PATTERN,
    SYNTAX_OP_PATTERN,
    SYNTAX_PUNCT_PATTERN,
    SYNTAX_KEYWORDS,
    SYNTAX_LITERALS,
    findCodeBindings,
} = CodeBindings;
