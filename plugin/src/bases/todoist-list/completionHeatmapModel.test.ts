import { describe, expect, it } from "vitest";

import {
  buildCompletionHeatmapModel,
  type CompletionHeatmapEvent,
  completionHeatmapCalendarYearRange,
  formatCompletionHeatmapDateRange,
  isCompletionHeatmapRange,
} from "./completionHeatmapModel";

const NOW = new Date("2026-08-12T12:00:00.000Z");

const event = (id: string, completedAt: string): CompletionHeatmapEvent => ({ id, completedAt });

describe("buildCompletionHeatmapModel", () => {
  it("builds a Sunday-first 7-row week grid for a rolling range", () => {
    const model = buildCompletionHeatmapModel({
      events: [
        event("before", "2026-07-15T12:00:00.000Z"),
        event("start", "2026-07-16T12:00:00.000Z"),
        event("today", "2026-08-12T12:00:00.000Z"),
      ],
      now: NOW,
      range: "last-4-weeks",
      timeZone: "UTC",
    });

    expect(model.startKey).toBe("2026-07-16");
    expect(model.endKey).toBe("2026-08-12");
    expect(model.periodLabel).toBe("July 16 – August 12, 2026");
    expect(model.totalCount).toBe(2);
    expect(model.weeks).toHaveLength(5);
    expect(model.weeks.every((week) => week.days.length === 7)).toBe(true);
    expect(model.weeks[0]?.days[0]).toMatchObject({
      key: "2026-07-12",
      inRange: false,
      weekdayIndex: 0,
    });
    expect(model.weeks[4]?.days[3]).toMatchObject({
      key: "2026-08-12",
      inRange: true,
      weekdayIndex: 3,
    });
    expect(model.monthLabels).toEqual([
      { fullLabel: "July", shortLabel: "Jul", startWeek: 0, weekSpan: 2 },
      { fullLabel: "August", shortLabel: "Aug", startWeek: 2, weekSpan: 3 },
    ]);
  });

  it("uses the requested IANA time zone to bucket completion instants", () => {
    const events = [event("midnight", "2026-08-12T00:30:00.000Z")];
    const losAngeles = buildCompletionHeatmapModel({
      events,
      now: NOW,
      range: "last-4-weeks",
      timeZone: "America/Los_Angeles",
    });
    const shanghai = buildCompletionHeatmapModel({
      events,
      now: NOW,
      range: "last-4-weeks",
      timeZone: "Asia/Shanghai",
    });

    expect(losAngeles.daysByKey.get("2026-08-11")?.count).toBe(1);
    expect(losAngeles.daysByKey.get("2026-08-12")?.count).toBe(0);
    expect(shanghai.daysByKey.get("2026-08-11")?.count).toBe(0);
    expect(shanghai.daysByKey.get("2026-08-12")?.count).toBe(1);
  });

  it("keeps local calendar days correct across a daylight-saving transition", () => {
    const model = buildCompletionHeatmapModel({
      events: [
        event("before-transition", "2026-03-08T04:30:00.000Z"),
        event("after-transition", "2026-03-08T07:30:00.000Z"),
      ],
      now: new Date("2026-03-08T12:00:00.000Z"),
      range: "last-4-weeks",
      timeZone: "America/New_York",
    });

    expect(model.daysByKey.get("2026-03-07")?.count).toBe(1);
    expect(model.daysByKey.get("2026-03-08")?.count).toBe(1);
  });

  it("clamps rolling calendar-month ranges and includes both boundaries", () => {
    const model = buildCompletionHeatmapModel({
      events: [
        event("before", "2026-02-27T12:00:00.000Z"),
        event("start", "2026-02-28T12:00:00.000Z"),
        event("end", "2026-05-31T12:00:00.000Z"),
        event("future", "2026-06-01T12:00:00.000Z"),
      ],
      now: new Date("2026-05-31T18:00:00.000Z"),
      range: "last-3-months",
      timeZone: "UTC",
    });

    expect(model.startKey).toBe("2026-02-28");
    expect(model.endKey).toBe("2026-05-31");
    expect(model.totalCount).toBe(2);
  });

  it("assigns four quartile levels to positive daily counts and keeps zero separate", () => {
    const events: CompletionHeatmapEvent[] = [];
    for (const [day, count] of [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        events.push(
          event(`${day}-${index}`, `2026-08-${day.toString().padStart(2, "0")}T12:00:00Z`),
        );
      }
    }

    const model = buildCompletionHeatmapModel({
      events,
      now: NOW,
      range: "last-4-weeks",
      timeZone: "UTC",
    });

    expect(model.daysByKey.get("2026-08-01")?.level).toBe(1);
    expect(model.daysByKey.get("2026-08-02")?.level).toBe(2);
    expect(model.daysByKey.get("2026-08-03")?.level).toBe(3);
    expect(model.daysByKey.get("2026-08-04")?.level).toBe(4);
    expect(model.daysByKey.get("2026-08-05")?.level).toBe(0);
  });

  it("keeps the busiest sparse day at the More end of the intensity scale", () => {
    const singleDay = buildCompletionHeatmapModel({
      events: [event("only", "2026-08-01T12:00:00Z")],
      now: NOW,
      range: "last-4-weeks",
      timeZone: "UTC",
    });
    expect(singleDay.daysByKey.get("2026-08-01")?.level).toBe(4);

    const sparse = buildCompletionHeatmapModel({
      events: [
        event("one", "2026-08-01T12:00:00Z"),
        event("two-a", "2026-08-02T12:00:00Z"),
        event("two-b", "2026-08-02T13:00:00Z"),
        event("three-a", "2026-08-03T12:00:00Z"),
        event("three-b", "2026-08-03T13:00:00Z"),
        event("three-c", "2026-08-03T14:00:00Z"),
      ],
      now: NOW,
      range: "last-4-weeks",
      timeZone: "UTC",
    });
    expect(sparse.daysByKey.get("2026-08-01")?.level).toBe(1);
    expect(sparse.daysByKey.get("2026-08-03")?.level).toBe(4);
    expect(sparse.daysByKey.get("2026-08-04")?.level).toBe(0);
  });

  it("derives calendar-year choices from data and builds complete historical years", () => {
    const model = buildCompletionHeatmapModel({
      events: [
        event("old", "2024-03-01T12:00:00Z"),
        event("selected", "2025-12-31T23:00:00Z"),
        event("invalid", "not-a-date"),
      ],
      now: NOW,
      range: completionHeatmapCalendarYearRange(2025),
      timeZone: "UTC",
    });

    expect(model.availableYears).toEqual([2026, 2025, 2024]);
    expect(model.startKey).toBe("2025-01-01");
    expect(model.endKey).toBe("2025-12-31");
    expect(model.totalCount).toBe(1);
  });

  it("keeps zero-activity gap years available for GitHub-style year navigation", () => {
    const model = buildCompletionHeatmapModel({
      events: [event("old", "2023-03-01T12:00:00Z")],
      now: NOW,
      range: "last-year",
      timeZone: "UTC",
    });

    expect(model.availableYears).toEqual([2026, 2025, 2024, 2023]);
  });

  it("labels a shared boundary week with the month that occupies the graph", () => {
    const model = buildCompletionHeatmapModel({
      events: [],
      now: new Date("2027-02-27T12:00:00.000Z"),
      range: "last-4-weeks",
      timeZone: "UTC",
    });

    expect(model.startKey).toBe("2027-01-31");
    expect(model.monthLabels).toEqual([
      { fullLabel: "February", shortLabel: "Feb", startWeek: 0, weekSpan: 4 },
    ]);
  });

  it("defensively counts a completion event id only once", () => {
    const model = buildCompletionHeatmapModel({
      events: [
        event("same-event", "2026-08-10T10:00:00Z"),
        event("same-event", "2026-08-11T10:00:00Z"),
      ],
      now: NOW,
      range: "last-4-weeks",
      timeZone: "UTC",
    });

    expect(model.totalCount).toBe(1);
    expect(model.daysByKey.get("2026-08-10")?.count).toBe(1);
    expect(model.daysByKey.get("2026-08-11")?.count).toBe(0);
  });

  it("keeps an all-zero date scaffold for empty periods", () => {
    const model = buildCompletionHeatmapModel({
      events: [],
      now: NOW,
      range: "last-year",
      timeZone: "UTC",
    });

    expect(model.totalCount).toBe(0);
    expect(model.weeks.length).toBeGreaterThanOrEqual(52);
    expect([...model.daysByKey.values()].every((day) => day.level === 0)).toBe(true);
  });
});

describe("completion heatmap range helpers", () => {
  it("validates supported controlled values", () => {
    expect(isCompletionHeatmapRange("last-year")).toBe(true);
    expect(isCompletionHeatmapRange("year:2025")).toBe(true);
    expect(isCompletionHeatmapRange("last-month")).toBe(false);
    expect(isCompletionHeatmapRange("year:0202")).toBe(false);
    expect(isCompletionHeatmapRange("year:10000")).toBe(false);
    expect(() => completionHeatmapCalendarYearRange(0)).toThrowError(
      "Invalid completion heatmap calendar year",
    );
  });

  it("formats compact same-month ranges without dropping the month", () => {
    expect(formatCompletionHeatmapDateRange("2026-08-10", "2026-08-12")).toBe(
      "August 10 – 12, 2026",
    );
  });
});
