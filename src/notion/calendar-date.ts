const LATE_NIGHT_START_MINUTE = 55;

/**
 * Converts late-night deadlines to date-only values for all-day Notion Calendar
 * display. The local date is calculated in the Canvas course timezone.
 */
export function notionCalendarDate(
  timestamp: string | null,
  timeZone: string | null | undefined,
): string | null {
  if (!timestamp || !timeZone) return timestamp;

  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return timestamp;

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const hour = Number(values.hour);
    const minute = Number(values.minute);

    if (hour !== 23 || minute < LATE_NIGHT_START_MINUTE) return timestamp;
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    // Invalid or unsupported IANA timezone: keep Canvas's exact timestamp.
    return timestamp;
  }
}
