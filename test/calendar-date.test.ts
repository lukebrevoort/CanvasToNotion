import assert from "node:assert/strict";
import test from "node:test";
import { notionCalendarDate } from "../src/notion/calendar-date.js";

test("converts an 11:59 PM daylight-time deadline to its local calendar date", () => {
  assert.equal(notionCalendarDate("2026-09-09T03:59:59Z", "America/New_York"), "2026-09-08");
});

test("converts an 11:55 PM standard-time deadline to its local calendar date", () => {
  assert.equal(notionCalendarDate("2026-12-02T04:55:00Z", "America/New_York"), "2026-12-01");
});

test("preserves timed deadlines before the late-night all-day window", () => {
  const timestamp = "2026-09-09T03:54:59Z";
  assert.equal(notionCalendarDate(timestamp, "America/New_York"), timestamp);
});

test("preserves timestamps when the course timezone is unavailable or invalid", () => {
  const timestamp = "2026-09-09T03:59:59Z";
  assert.equal(notionCalendarDate(timestamp, null), timestamp);
  assert.equal(notionCalendarDate(timestamp, "Not/A_Time_Zone"), timestamp);
});

test("preserves an absent deadline", () => {
  assert.equal(notionCalendarDate(null, "America/New_York"), null);
});
