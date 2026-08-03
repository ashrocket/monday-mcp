import { describe, expect, it } from "vitest";
import {
  ColumnValueError,
  buildColumnValues,
  decodeColumnValue,
  dropdownLabels,
  formatColumnValue,
  resolveColumn,
  statusLabels,
  type BoardColumn,
} from "../src/columns.js";

const status: BoardColumn = {
  id: "status",
  title: "Status",
  type: "status",
  settings_str: JSON.stringify({
    labels: { "0": "Working on it", "1": "Done", "5": "Stuck" },
  }),
};

const dropdown: BoardColumn = {
  id: "dropdown_1",
  title: "Team",
  type: "dropdown",
  settings_str: JSON.stringify({
    labels: [
      { id: 1, name: "Design" },
      { id: 2, name: "Build" },
    ],
  }),
};

const columns: BoardColumn[] = [
  status,
  dropdown,
  { id: "text_1", title: "Notes", type: "text" },
  { id: "date_1", title: "Due date", type: "date" },
  { id: "numbers_1", title: "Effort", type: "numbers" },
  { id: "person", title: "Owner", type: "people" },
  { id: "check", title: "Signed off", type: "checkbox" },
  { id: "formula_1", title: "Score", type: "formula" },
  { id: "files", title: "Assets", type: "file" },
];

describe("statusLabels and dropdownLabels", () => {
  it("reads status labels in index order", () => {
    expect(statusLabels(status)).toEqual(["Working on it", "Done", "Stuck"]);
  });

  it("reads dropdown labels", () => {
    expect(dropdownLabels(dropdown)).toEqual(["Design", "Build"]);
  });

  it("survives settings that are not JSON", () => {
    expect(statusLabels({ id: "a", title: "A", type: "status", settings_str: "{" })).toEqual([]);
  });
});

describe("resolveColumn", () => {
  it("finds a column by id", () => {
    expect(resolveColumn(columns, "text_1").title).toBe("Notes");
  });

  it("finds a column by title, ignoring case and spacing", () => {
    expect(resolveColumn(columns, "due date").id).toBe("date_1");
    expect(resolveColumn(columns, "DueDate").id).toBe("date_1");
    expect(resolveColumn(columns, "due_date").id).toBe("date_1");
  });

  it("lists the real columns when the name is wrong", () => {
    expect(() => resolveColumn(columns, "Deadline")).toThrow(/no column "Deadline"/);
    expect(() => resolveColumn(columns, "Deadline")).toThrow(/date_1 = "Due date"/);
  });

  it("asks for an id when two columns share a title", () => {
    const twins: BoardColumn[] = [
      { id: "a", title: "Owner", type: "text" },
      { id: "b", title: "owner", type: "text" },
    ];
    expect(() => resolveColumn(twins, "Owner")).toThrow(/More than one column/);
  });
});

describe("formatColumnValue", () => {
  it("turns a status label into its real index, not its array position", () => {
    expect(formatColumnValue(status, "Stuck")).toEqual({ index: 5 });
    expect(formatColumnValue(status, "done")).toEqual({ index: 1 });
  });

  it("names the valid labels when a status is wrong", () => {
    expect(() => formatColumnValue(status, "Finished")).toThrow(
      /no status "Finished".*"Working on it", "Done", "Stuck"/s,
    );
  });

  it("accepts a numeric status index", () => {
    expect(formatColumnValue(status, 5)).toEqual({ index: 5 });
  });

  it("checks dropdown options", () => {
    expect(formatColumnValue(dropdown, ["Design"])).toEqual({ labels: ["Design"] });
    expect(() => formatColumnValue(dropdown, "Marketing")).toThrow(/no option "Marketing"/);
  });

  it("splits a date and a time", () => {
    expect(formatColumnValue(columns[3] as BoardColumn, "2026-08-14")).toEqual({
      date: "2026-08-14",
    });
    expect(formatColumnValue(columns[3] as BoardColumn, "2026-08-14 09:30")).toEqual({
      date: "2026-08-14",
      time: "09:30:00",
    });
    expect(formatColumnValue(columns[3] as BoardColumn, "2026-08-14T09:30:15Z")).toEqual({
      date: "2026-08-14",
      time: "09:30:15",
    });
  });

  it("rejects a date that is not a date", () => {
    expect(() => formatColumnValue(columns[3] as BoardColumn, "next tuesday")).toThrow(
      /not a date/,
    );
  });

  it("stores a number as a string", () => {
    expect(formatColumnValue(columns[4] as BoardColumn, 3)).toBe("3");
    expect(formatColumnValue(columns[4] as BoardColumn, "3.5")).toBe("3.5");
    expect(() => formatColumnValue(columns[4] as BoardColumn, "many")).toThrow(/not a number/);
  });

  it("builds a people value from ids and from team prefixes", () => {
    expect(formatColumnValue(columns[5] as BoardColumn, [12, "team:34"])).toEqual({
      personsAndTeams: [
        { id: 12, kind: "person" },
        { id: 34, kind: "team" },
      ],
    });
  });

  it("builds a checkbox value", () => {
    expect(formatColumnValue(columns[6] as BoardColumn, true)).toEqual({ checked: "true" });
    expect(formatColumnValue(columns[6] as BoardColumn, "yes")).toEqual({ checked: "true" });
    expect(formatColumnValue(columns[6] as BoardColumn, false)).toEqual({});
  });

  it("clears a column with null", () => {
    expect(formatColumnValue(status, null)).toEqual({});
    expect(formatColumnValue(columns[2] as BoardColumn, null)).toBe("");
  });

  it("passes an object through untouched", () => {
    const raw = { index: 2, post_id: null };
    expect(formatColumnValue(status, raw)).toBe(raw);
  });

  it("refuses a computed column", () => {
    expect(() => formatColumnValue(columns[7] as BoardColumn, "5")).toThrow(
      /monday.com computes/,
    );
  });

  it("refuses a file column and says why", () => {
    expect(() => formatColumnValue(columns[8] as BoardColumn, "a.png")).toThrow(
      /file upload endpoint/,
    );
  });

  it("passes an unknown column type straight through", () => {
    const odd: BoardColumn = { id: "x", title: "X", type: "brand_new_type" };
    expect(formatColumnValue(odd, "whatever")).toBe("whatever");
  });
});

describe("buildColumnValues", () => {
  it("keys the result by column id, whatever the caller used", () => {
    expect(
      buildColumnValues(columns, { Status: "Done", "due date": "2026-01-02", Notes: "hi" }),
    ).toEqual({
      status: { index: 1 },
      date_1: { date: "2026-01-02" },
      text_1: "hi",
    });
  });

  it("reports the first bad column", () => {
    expect(() => buildColumnValues(columns, { Nope: 1 })).toThrow(ColumnValueError);
  });
});

describe("decodeColumnValue", () => {
  it("parses stored JSON", () => {
    expect(decodeColumnValue('{"index":1}')).toEqual({ index: 1 });
  });

  it("returns null for an empty value", () => {
    expect(decodeColumnValue("")).toBeNull();
    expect(decodeColumnValue(null)).toBeNull();
  });

  it("returns the raw text when it is not JSON", () => {
    expect(decodeColumnValue("plain")).toBe("plain");
  });
});
