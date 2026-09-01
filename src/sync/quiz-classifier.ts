export interface QuizClassificationInput {
  name?: string;
  quiz_id?: number | null;
  is_quiz_assignment?: boolean;
  is_quiz_lti_assignment?: boolean;
  submission_types?: readonly string[];
}

/** Classifies quizzes from explicit Canvas API signals, including New Quizzes over LTI. */
export function isQuizAssignment(assignment: QuizClassificationInput): boolean {
  return Boolean(
    assignment.quiz_id != null ||
    assignment.is_quiz_assignment ||
    assignment.is_quiz_lti_assignment ||
    assignment.submission_types?.includes("online_quiz"),
  );
}
