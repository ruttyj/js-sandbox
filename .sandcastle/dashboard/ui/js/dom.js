// A minimal DOM morph: updates `container` to match an HTML string while
// keeping every node that didn't change. Views re-render every second (for
// clocks), and replacing their DOM outright would restart CSS animations,
// drop hover states and reset scroll positions.
//
// Children are matched by position, or by `data-key` when present, so a
// reordered list moves its nodes rather than rebuilding them.

const template = document.createElement('template');

const syncAttributes = (target, source) => {
    for (const { name } of [...target.attributes]) {
        if (!source.hasAttribute(name)) {
            target.removeAttribute(name);
        }
    }

    for (const { name, value } of [...source.attributes]) {
        if (target.getAttribute(name) !== value) {
            target.setAttribute(name, value);
        }
    }
};

const isSameKind = (target, source) => {
    if (target.nodeType !== source.nodeType || target.nodeName !== source.nodeName) {
        return false;
    }

    if (target.nodeType !== Node.ELEMENT_NODE) {
        return true;
    }
    return target.getAttribute('data-key') === source.getAttribute('data-key');
};

const morphNode = (target, source) => {
    if (target.nodeType === Node.TEXT_NODE || target.nodeType === Node.COMMENT_NODE) {
        if (target.nodeValue !== source.nodeValue) {
            target.nodeValue = source.nodeValue;
        }
        return;
    }

    syncAttributes(target, source);
    morphChildren(target, source);
};

// Keyed children found anywhere among the current ones, so a keyed node that
// moved position is reused instead of recreated.
const indexKeyedChildren = (parent) => {
    const keyed = new Map();
    for (const child of parent.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && child.hasAttribute('data-key')) {
            keyed.set(child.getAttribute('data-key'), child);
        }
    }
    return keyed;
};

const morphChildren = (target, source) => {
    const keyed = indexKeyedChildren(target);
    const sourceChildren = [...source.childNodes];

    for (let index = 0; index < sourceChildren.length; index++) {
        const sourceChild = sourceChildren[index];
        let targetChild = target.childNodes[index];

        const key = sourceChild.nodeType === Node.ELEMENT_NODE ? sourceChild.getAttribute('data-key') : null;
        const keyedMatch = key === null ? undefined : keyed.get(key);
        if (keyedMatch && keyedMatch !== targetChild) {
            target.insertBefore(keyedMatch, targetChild ?? null);
            targetChild = keyedMatch;
        }

        if (targetChild && isSameKind(targetChild, sourceChild)) {
            morphNode(targetChild, sourceChild);
        } else if (targetChild) {
            target.replaceChild(sourceChild.cloneNode(true), targetChild);
        } else {
            target.appendChild(sourceChild.cloneNode(true));
        }
    }

    while (target.childNodes.length > sourceChildren.length) {
        target.removeChild(target.lastChild);
    }
};

// Skips the work entirely when the HTML is unchanged since the last morph.
export const morph = (container, html) => {
    if (container.__lastHtml === html) {
        return;
    }

    container.__lastHtml = html;
    template.innerHTML = html;
    morphChildren(container, template.content);
};
