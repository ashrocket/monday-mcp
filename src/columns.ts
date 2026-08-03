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

/** Column types the API refuses to write. */
export const READ_ONLY_TYPES = new Set([
  "auto_number",
  "button",
  "creation_log",
  "formula",
  "integration",
  "item_id",
  "last_updated",
  "mirror",
  "name",
  "progress",
  "subtasks",
  "time_tracking",
  "vote",
]);

/** Column types that need their own upload endpoint, not column_values. */
export const UNSUPPORTED_WRITE_TYPES = new Set(["file", "doc"]);

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

/** Finds the numeric index of a status label, ignoring letter case. */
export function statusIndexFor(column: BoardColumn, label: string): number | undefined {
  const labels = parseSettings(column).labels;
  if (!labels || typeof labels !== "object") return undefined;
  for (const [index, value] of Object.entries(labels as Record<string, unknown>)) {
    if (String(value).toLowerCase() === label.toLowerCase()) return Number(index);
  }
  return undefined;
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

/** Splits a date input into the date part and the optional time part. */
function splitDateTime(raw: string): { date: string; time?: string } {
  const trimmed = raw.trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/.exec(trimmed);
  if (!match?.[1]) {
    throw new ColumnValueError(
      `"${raw}" is not a date. Use YYYY-MM-DD, or YYYY-MM-DD HH:MM:SS for a time.`,
    );
  }
  const time = match[2];
  return time ? { date: match[1], time: time.length === 5 ? `${time}:00` : time } : { date: match[1] };
}

function personEntry(value: unknown): { id: number; kind: string } {
  if (typeof value === "object" && value !== null) {
    const entry = value as Record<string, unknown>;
    return { id: Number(entry.id), kind: String(entry.kind ?? "person") };
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
  return { id, kind: "person" };
}

function numericIds(value: unknown, what: string): number[] {
  return asArray(value)
    .filter((entry) => entry !== null && entry !== undefined && entry !== "")
    .map((entry) => {
      const id = Number(entry);
      if (!Number.isFinite(id)) {
        throw new ColumnValueError(`"${String(entry)}" is not a numeric ${what} id.`);
      }
      return id;
    });
}

/** True when the value asks to empty the column. */
function isClear(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Turns a plain value into the JSON value that monday.com stores for this
 * column type. An object value passes through untouched, so a caller that
 * already knows the exact shape stays in control.
 */
export function formatColumnValue(column: BoardColumn, value: unknown): unknown {
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
    return type === "text" || type === "numbers" ? "" : {};
  }

  // The caller knows the exact API shape. Trust it.
  const isPlainObject =
    typeof value === "object" && value !== null && !Array.isArray(value);

  switch (type) {
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

    case "status":
    case "color": {
      if (isPlainObject) return value;
      if (typeof value === "number") return { index: value };
      const label = String(value);
      const index = statusIndexFor(column, label);
      if (index === undefined) {
        const options = statusLabels(column);
        throw new ColumnValueError(
          `Column "${column.title}" has no status "${label}". ` +
            `It accepts: ${options.length > 0 ? options.map((item) => `"${item}"`).join(", ") : "no labels yet"}.`,
        );
      }
      return { index };
    }

    case "dropdown": {
      if (isPlainObject) return value;
      const wanted = asArray(value).map((entry) => String(entry));
      const options = dropdownLabels(column);
      if (options.length > 0) {
        const unknownLabels = wanted.filter(
          (label) => !options.some((option) => option.toLowerCase() === label.toLowerCase()),
        );
        if (unknownLabels.length > 0) {
          throw new ColumnValueError(
            `Column "${column.title}" has no option ${unknownLabels.map((item) => `"${item}"`).join(", ")}. ` +
              `It accepts: ${options.map((item) => `"${item}"`).join(", ")}.`,
          );
        }
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

    case "people":
    case "multiple-person": {
      if (isPlainObject && "personsAndTeams" in (value as Record<string, unknown>)) {
        return value;
      }
      return { personsAndTeams: asArray(value).map(personEntry) };
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

    case "phone": {
      if (isPlainObject) return value;
      return { phone: String(value), countryShortName: "US" };
    }

    case "tags":
      return isPlainObject ? value : { tag_ids: numericIds(value, "tag") };

    case "board_relation":
    case "dependency":
      return isPlainObject ? value : { item_ids: numericIds(value, "item") };

    case "rating": {
      if (isPlainObject) return value;
      return { rating: Number(value) };
    }

    case "hour": {
      if (isPlainObject) return value;
      const match = /^(\d{1,2}):(\d{2})/.exec(String(value));
      if (!match?.[1] || !match[2]) {
        throw new ColumnValueError(
          `Column "${column.title}" holds an hour. Use HH:MM, for example "14:30".`,
        );
      }
      return { hour: Number(match[1]), minute: Number(match[2]) };
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

    case "country": {
      if (isPlainObject) return value;
      const code = String(value).toUpperCase();
      if (code.length !== 2) {
        throw new ColumnValueError(
          `Column "${column.title}" holds a country. Use a two letter code, for example "US".`,
        );
      }
      return { countryCode: code, countryName: code };
    }

    case "location":
      return isPlainObject ? value : { address: String(value) };

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
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const column = resolveColumn(columns, key);
    output[column.id] = formatColumnValue(column, value);
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
