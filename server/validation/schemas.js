// The shapes the API accepts. Records are checked as far as the server relies on them (types and
// sizes); nested parts the browser derives, like a scope's variables, only have to be arrays of
// objects, since their exact shape belongs to the frontend.
import { z } from 'zod';

const MAX_CODE_LENGTH = 1_000_000;
const MAX_LIST_LENGTH = 50_000;

const label = z.string().min(1).max(200);
const looseObjects = z.array(z.record(z.string(), z.unknown())).max(MAX_LIST_LENGTH);

// A record key in a URL: a scope id, or an item/variable tag key.
export const keyParams = z.object({ key: z.string().min(1).max(200) });

export const shareTokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

// ?version= on a delete.
export const versionQuery = z.object({ version: z.coerce.number().int().min(1) });

export const reorderBody = z.object({ keys: z.array(z.string().min(1).max(200)).max(MAX_LIST_LENGTH) });

export const scopeData = z.object({
    name: label,
    code: z.string().max(MAX_CODE_LENGTH),
    variables: looseObjects,
    itemTagKeys: z.array(z.string().max(200)).max(MAX_LIST_LENGTH),
    itemColors: z.record(z.string(), z.string().max(50)),
    colorSeed: z.number().optional(),
});

export const itemTagData = z.object({
    label,
    parent: z.string().max(200).nullable().optional(),
    items: z.array(z.union([z.number(), z.string().max(50)])).max(MAX_LIST_LENGTH),
});

export const variableTagData = z.object({ label });

export const globalsData = z.object({
    code: z.string().max(MAX_CODE_LENGTH),
    variables: looseObjects,
});

export const settingsData = z.object({
    editorSettings: z.record(z.string(), z.boolean()),
    dashboardFilter: z.array(z.string().max(200)).max(1000),
});

// PUT body for a record in a collection. version is null for a record never saved before.
export const collectionSaveBody = (dataSchema) => z.object({
    version: z.number().int().min(1).nullable(),
    position: z.number().int().min(0),
    data: dataSchema,
});

// PUT body for a one-per-user record. version is 0 when it was never saved.
export const documentSaveBody = (dataSchema) => z.object({
    version: z.number().int().min(0),
    data: dataSchema,
});
