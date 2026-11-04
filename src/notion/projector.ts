/** Node entrypoint: preserve existing callers while resolving local destinations. */
import { savedDbIds } from "./schema.js";
import {
  upsertAssignmentPage as projectAssignment,
  upsertCoursePage as projectCourse,
} from "./projector-core.js";
export { assignmentProperties } from "./projector-core.js";
export type { ProjectionDestinations } from "./projector-core.js";

export function upsertCoursePage(
  client: Parameters<typeof projectCourse>[0],
  course: Parameters<typeof projectCourse>[1],
  domain: string,
): ReturnType<typeof projectCourse> {
  return projectCourse(client, course, domain, savedDbIds());
}

export function upsertAssignmentPage(
  client: Parameters<typeof projectAssignment>[0],
  row: Parameters<typeof projectAssignment>[1],
  domain: string,
  options: Parameters<typeof projectAssignment>[3],
): ReturnType<typeof projectAssignment> {
  return projectAssignment(client, row, domain, options, savedDbIds());
}
