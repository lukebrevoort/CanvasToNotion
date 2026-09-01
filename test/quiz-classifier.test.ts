import assert from "node:assert/strict";
import test from "node:test";
import { isQuizAssignment } from "../src/sync/quiz-classifier.js";

test("classifies a Canvas New Quiz launched through LTI as a quiz", () => {
  assert.equal(
    isQuizAssignment({
      quiz_id: null,
      is_quiz_assignment: false,
      is_quiz_lti_assignment: true,
      submission_types: ["external_tool"],
    }),
    true,
  );
});

test("classifies classic Canvas quiz signals as quizzes", () => {
  assert.equal(isQuizAssignment({ quiz_id: 620, submission_types: ["online_quiz"] }), true);
  assert.equal(isQuizAssignment({ quiz_id: null, is_quiz_assignment: true }), true);
  assert.equal(isQuizAssignment({ quiz_id: null, submission_types: ["online_quiz"] }), true);
});

test("does not classify an ordinary external-tool assignment as a quiz", () => {
  assert.equal(
    isQuizAssignment({
      quiz_id: null,
      is_quiz_assignment: false,
      is_quiz_lti_assignment: false,
      submission_types: ["external_tool"],
    }),
    false,
  );
});

test("does not infer quiz status from an assignment title", () => {
  assert.equal(
    isQuizAssignment({
      name: "Quiz review worksheet",
      quiz_id: null,
      submission_types: ["online_upload"],
    }),
    false,
  );
});
