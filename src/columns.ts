/**
 * Column value translation.
 *
 * monday.com stores each column type in a different JSON shape. A model
 * that writes `"Done"` into a status column gets a silent no-op or a
 * cryptic error. This module turns plain values into the exact shape the
 * API wants, and it names the mistake when the value cannot work.
 */

export interface BoardColumn {
  id: string;
  title: string;
  type: string;
  settings_str?: string | null;
}

/**
 * Column types the API refuses to write, because monday.com computes them.
 * The item name is NOT in this set. monday.com accepts "name" as a key in
 * column_values.
 */
export const READ_ONLY_TYPES = new Set([
  "auto_number",
  "button",
  "creation_log",
  "formula",
  "integration",
  "item_id",
  "last_updated",
  "mirror",
  "progress",
  "subtasks",
  "time_tracking",
  "vote",
]);

/** Column types that need their own upload endpoint, not column_values. */
export const UNSUPPORTED_WRITE_TYPES = new Set(["file", "doc"]);

/** Older aliases monday.com still reports for the status column. */
const STATUS_TYPES = new Set(["status", "color"]);

/** Older aliases monday.com still reports for the people column. */
const PEOPLE_TYPES = new Set(["people", "multiple-person", "person", "team"]);

/**
 * Calling code to ISO country, for the phone column. It covers the common
 * cases only. Anything else must arrive as an explicit country.
 */
const CALLING_CODES: Record<string, string> = {
  "1": "US",
  "20": "EG",
  "27": "ZA",
  "30": "GR",
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "36": "HU",
  "39": "IT",
  "40": "RO",
  "41": "CH",
  "43": "AT",
  "44": "GB",
  "45": "DK",
  "46": "SE",
  "47": "NO",
  "48": "PL",
  "49": "DE",
  "51": "PE",
  "52": "MX",
  "54": "AR",
  "55": "BR",
  "56": "CL",
  "57": "CO",
  "60": "MY",
  "61": "AU",
  "62": "ID",
  "63": "PH",
  "64": "NZ",
  "65": "SG",
  "66": "TH",
  "81": "JP",
  "82": "KR",
  "84": "VN",
  "86": "CN",
  "90": "TR",
  "91": "IN",
  "92": "PK",
  "234": "NG",
  "254": "KE",
  "351": "PT",
  "353": "IE",
  "358": "FI",
  "370": "LT",
  "372": "EE",
  "380": "UA",
  "420": "CZ",
  "421": "SK",
  "852": "HK",
  "886": "TW",
  "971": "AE",
  "972": "IL",
};

/** Thrown when a value cannot become a valid column value. */
export class ColumnValueError extends Error {
  override name = "ColumnValueError";
}

function parseSettings(column: BoardColumn): Record<string, unknown> {
  if (!column.settings_str) return {};
  try {
    return JSON.parse(column.settings_str) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Returns the labels a status column accepts, in index order. */
export function statusLabels(column: BoardColumn): string[] {
  const labels = parseSettings(column).labels;
  if (!labels || typeof labels !== "object") return [];
  return Object.entries(labels as Record<string, unknown>)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, label]) => String(label))
    .filter((label) => label.length > 0);
}

/** Returns the labels a dropdown column accepts. */
export function dropdownLabels(column: BoardColumn): string[] {
  const labels = parseSettings(column).labels;
  if (!Array.isArray(labels)) return [];
  return labels
    .map((entry) => {
      if (entry && typeof entry === "object") {
        return String((entry as Record<string, unknown>).name ?? "");
      }
      return String(entry);
    })
    .filter((label) => label.length > 0);
}

/**
 * Finds a status label, ignoring letter case, and returns both its index
 * and the stored spelling. The stored spelling matters: monday.com matches
 * a label by exact text, so echoing the caller's casing can create a
 * duplicate label rather than reuse the existing one.
 */
export function statusEntryFor(
  column: BoardColumn,
  label: string,
): { index: number; label: string } | undefined {
  const labels = parseSettings(column).labels;
  if (!labels || typeof labels !== "object") return undefined;
  for (const [index, value] of Object.entries(labels as Record<string, unknown>)) {
    if (String(value).toLowerCase() === label.toLowerCase()) {
      return { index: Number(index), label: String(value) };
    }
  }
  return undefined;
}

/** Finds the numeric index of a status label, ignoring letter case. */
export function statusIndexFor(column: BoardColumn, label: string): number | undefined {
  return statusEntryFor(column, label)?.index;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Finds a column by id or by title. Title match ignores letter case,
 * spaces, hyphens and underscores, because a model rarely copies a title
 * exactly.
 */
export function resolveColumn(columns: BoardColumn[], key: string): BoardColumn {
  const exactId = columns.find((column) => column.id === key);
  if (exactId) return exactId;

  const wanted = normalise(key);
  const byTitle = columns.filter((column) => normalise(column.title) === wanted);
  if (byTitle.length === 1) return byTitle[0] as BoardColumn;
  if (byTitle.length > 1) {
    throw new ColumnValueError(
      `More than one column is called "${key}". Use a column id instead: ` +
        byTitle.map((column) => `${column.id} (${column.title})`).join(", "),
    );
  }

  const looseId = columns.find((column) => normalise(column.id) === wanted);
  if (looseId) return looseId;

  const known = columns
    .map((column) => `${column.id} = "${column.title}" (${column.type})`)
    .join(", ");
  throw new ColumnValueError(
    `The board has no column "${key}". Known columns: ${known || "none"}.`,
  );
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Splits a date input into the date part and the optional time part. The
 * pattern is anchored, so trailing rubbish is rejected instead of quietly
 * dropped.
 */
function splitDateTime(raw: string): { date: string; time?: string } {
  const trimmed = raw.trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(
    trimmed,
  );
  if (!match?.[1]) {
    throw new ColumnValueError(
      `"${raw}" is not a date. Use YYYY-MM-DD, or YYYY-MM-DD HH:MM:SS for a time.`,
    );
  }
  const time = match[2];
  return time
    ? { date: match[1], time: time.length === 5 ? `${time}:00` : time }
    : { date: match[1] };
}

function requireNumericId(value: unknown, what: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ColumnValueError(
      `"${String(value)}" is not a ${what} id. Use a positive whole number.`,
    );
  }
  return id;
}

function personEntry(value: unknown): { id: number; kind: string } {
  if (typeof value === "object" && value !== null) {
    const entry = value as Record<string, unknown>;
    const kind = String(entry.kind ?? "person");
    if (kind !== "person" && kind !== "team") {
      throw new ColumnValueError(
        `"${kind}" is not a valid kind. Use "person" or "team".`,
      );
    }
    return { id: requireNumericId(entry.id, "user or team"), kind };
  }
  const text = String(value);
  const prefixed = /^(person|team):(\d+)$/i.exec(text);
  if (prefixed?.[1] && prefixed[2]) {
    return { id: Number(prefixed[2]), kind: prefixed[1].toLowerCase() };
  }
  const id = Number(text);
  if (!Number.isFinite(id)) {
    throw new ColumnValueError(
      `"${text}" is not a person id. Use a numeric user id, or "team:123" for a team.`,
    );
  }
  return { id: requireNumericId(id, "user"), kind: "person" };
}

function numericIds(value: unknown, what: string): number[] {
  return asArray(value)
    .filter((entry) => entry !== null && entry !== undefined && entry !== "")
    .map((entry) => requireNumericId(entry, what));
}

/** Turns a two letter code into the country name monday.com stores. */
function countryValue(raw: unknown): { countryCode: string; countryName: string } {
  const code = String(raw).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new ColumnValueError(
      `"${String(raw)}" is not a country. Use a two letter ISO code, for example "US" or "GB".`,
    );
  }
  let name = code;
  try {
    name = new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    // An old runtime without Intl.DisplayNames. The code alone still works.
  }
  // An unassigned code comes back unchanged. CLDR also has a real entry for
  // ZZ, spelled "Unknown Region", which is not a country either.
  if (name === code || /unknown region/i.test(name)) {
    throw new ColumnValueError(
      `"${code}" is not a known ISO country code. Use a code such as "US", "GB" or "DE".`,
    );
  }
  return { countryCode: code, countryName: name };
}

/** Builds a phone value, which needs the country as well as the number. */
function phoneValue(column: BoardColumn, value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const [number, country] = value;
    return {
      phone: String(number ?? "").replace(/[^\d+]/g, ""),
      countryShortName: countryValue(country).countryCode,
    };
  }

  const text = String(value).trim();
  const digits = text.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    const bare = digits.slice(1);
    // Try the longest calling code first, so +1 does not shadow +12.
    for (const length of [3, 2, 1]) {
      const prefix = bare.slice(0, length);
      const country = CALLING_CODES[prefix];
      if (country) return { phone: bare, countryShortName: country };
    }
  }

  throw new ColumnValueError(
    `Column "${column.title}" holds a phone number, which monday.com stores with a country. ` +
      `Send ["${text}", "GB"] with the two letter country code, or an international ` +
      'number such as "+442071234567".',
  );
}

/** True when the value asks to empty the column. */
function isClear(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Turns a plain value into the JSON value that monday.com stores for this
 * column type. An object value passes through untouched, so a caller that
 * already knows the exact shape stays in control.
 *
 * `createLabels` mirrors the `create_labels_if_missing` mutation argument.
 * When it is true, a status or dropdown label that the board does not have
 * yet is passed through as text rather than rejected, because the mutation
 * itself will create it.
 */
export function formatColumnValue(
  column: BoardColumn,
  value: unknown,
  createLabels = false,
): unknown {
  const type = column.type;

  if (READ_ONLY_TYPES.has(type)) {
    throw new ColumnValueError(
      `Column "${column.title}" has type ${type}, which monday.com computes. It is not writable.`,
    );
  }
  if (UNSUPPORTED_WRITE_TYPES.has(type)) {
    throw new ColumnValueError(
      `Column "${column.title}" has type ${type}. It needs the file upload endpoint, ` +
        "which this server does not expose.",
    );
  }

  if (isClear(value)) {
    return type === "text" || type === "numbers" || type === "name" ? "" : {};
  }

  // The caller knows the exact API shape. Trust it.
  const isPlainObject =
    typeof value === "object" && value !== null && !Array.isArray(value);

  if (STATUS_TYPES.has(type)) {
    if (isPlainObject) return value;
    if (typeof value === "number") return { index: value };
    const label = String(value);
    const found = statusEntryFor(column, label);
    // The label form is what lets create_labels_if_missing do its work.
    if (found) return createLabels ? { label: found.label } : { index: found.index };
    if (createLabels) return { label };
    const options = statusLabels(column);
    throw new ColumnValueError(
      `Column "${column.title}" has no status "${label}". ` +
        `It accepts: ${options.length > 0 ? options.map((item) => `"${item}"`).join(", ") : "no labels yet"}. ` +
        "Send create_labels_if_missing true to add it.",
    );
  }

  if (PEOPLE_TYPES.has(type)) {
    if (isPlainObject && "personsAndTeams" in (value as Record<string, unknown>)) {
      return value;
    }
    return { personsAndTeams: asArray(value).map(personEntry) };
  }

  switch (type) {
    case "name":
    case "text":
      return String(value);

    case "long_text":
      return isPlainObject ? value : { text: String(value) };

    case "numbers": {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw new ColumnValueError(
          `Column "${column.title}" holds numbers, but "${String(value)}" is not a number.`,
        );
      }
      return String(numeric);
    }

    case "dropdown": {
      if (isPlainObject) return value;
      const wanted = asArray(value).map((entry) => String(entry));
      const options = dropdownLabels(column);
      if (options.length > 0) {
        const resolved: string[] = [];
        const unknownLabels: string[] = [];
        for (const label of wanted) {
          // Echo the stored spelling, so monday.com reuses the existing
          // option instead of creating a case variant of it.
          const match = options.find(
            (option) => option.toLowerCase() === label.toLowerCase(),
          );
          if (match) resolved.push(match);
          else unknownLabels.push(label);
        }
        if (unknownLabels.length > 0 && !createLabels) {
          throw new ColumnValueError(
            `Column "${column.title}" has no option ${unknownLabels.map((item) => `"${item}"`).join(", ")}. ` +
              `It accepts: ${options.map((item) => `"${item}"`).join(", ")}. ` +
              "Send create_labels_if_missing true to add it.",
          );
        }
        return { labels: [...resolved, ...unknownLabels] };
      }
      return { labels: wanted };
    }

    case "date": {
      if (isPlainObject) return value;
      return splitDateTime(String(value));
    }

    case "timeline": {
      if (isPlainObject) return value;
      const parts = asArray(value).map((entry) => splitDateTime(String(entry)).date);
      if (parts.length !== 2) {
        throw new ColumnValueError(
          `Column "${column.title}" is a timeline. Give two dates, for example ["2026-01-01", "2026-01-31"].`,
        );
      }
      return { from: parts[0], to: parts[1] };
    }

    case "checkbox": {
      if (isPlainObject) return value;
      const truthy =
        value === true || ["true", "1", "yes", "checked"].includes(String(value).toLowerCase());
      return truthy ? { checked: "true" } : {};
    }

    case "link": {
      if (isPlainObject) return value;
      const url = String(value);
      return { url, text: url };
    }

    case "email": {
      if (isPlainObject) return value;
      const email = String(value);
      return { email, text: email };
    }

    case "phone":
      return isPlainObject ? value : phoneValue(column, value);

    case "tags":
      return isPlainObject ? value : { tag_ids: numericIds(value, "tag") };

    case "board_relation":
    case "dependency":
      return isPlainObject ? value : { item_ids: numericIds(value, "item") };

    case "rating": {
      if (isPlainObject) return value;
      const rating = Number(value);
      if (!Number.isInteger(rating) || rating < 0) {
        throw new ColumnValueError(
          `Column "${column.title}" holds a rating. Use a whole number, for example 4.`,
        );
      }
      return { rating };
    }

    case "hour": {
      if (isPlainObject) return value;
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
      if (!match?.[1] || !match[2]) {
        throw new ColumnValueError(
          `Column "${column.title}" holds an hour. Use HH:MM, for example "14:30".`,
        );
      }
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) {
        throw new ColumnValueError(
          `"${String(value)}" is not a valid time of day. Use HH:MM between 00:00 and 23:59.`,
        );
      }
      return { hour, minute };
    }

    case "week": {
      if (isPlainObject) return value;
      const parts = asArray(value).map((entry) => splitDateTime(String(entry)).date);
      if (parts.length !== 2) {
        throw new ColumnValueError(
          `Column "${column.title}" holds a week. Give a start date and an end date.`,
        );
      }
      return { week: { startDate: parts[0], endDate: parts[1] } };
    }

    case "world_clock":
      return isPlainObject ? value : { timezone: String(value) };

    case "country":
      return isPlainObject ? value : countryValue(value);

    case "location": {
      if (isPlainObject) return value;
      // monday.com stores a location as coordinates. It does not geocode an
      // address, so a bare street address cannot work.
      throw new ColumnValueError(
        `Column "${column.title}" holds a location, which monday.com stores as coordinates. ` +
          'Send {"lat": "51.5074", "lng": "-0.1278", "address": "London"}. ' +
          "This server does not geocode an address.",
      );
    }

    default:
      // An unknown or new column type. Pass the value straight through and
      // let monday.com judge it.
      return value;
  }
}

/**
 * Builds the `column_values` map for a create or a change mutation.
 * Keys may be column ids or column titles.
 */
export function buildColumnValues(
  columns: BoardColumn[],
  input: Record<string, unknown>,
  createLabels = false,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const column = resolveColumn(columns, key);
    output[column.id] = formatColumnValue(column, value, createLabels);
  }
  return output;
}

/** Decodes the stored JSON of a column value, for a readable tool result. */
export function decodeColumnValue(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
