export interface CanvasCourse {
  id: number;
  name?: string;
  course_code?: string;
  workflow_state?: string;
  enrollment_term_id?: number;
  start_at?: string | null;
  end_at?: string | null;
  created_at?: string;
}

export interface CanvasAssignment {
  id: number;
  course_id: number;
  name: string;
  description?: string | null;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  points_possible?: number | null;
  submission_types?: string[];
  assignment_group_id?: number;
  quiz_id?: number | null;
  position?: number;
  updated_at?: string;
  created_at?: string;
}

export interface CanvasAssignmentGroup {
  id: number;
  name?: string;
  group_weight?: number | null;
}

export interface CanvasSubmission {
  assignment_id: number;
  workflow_state?: string;
  submitted_at?: string | null;
  graded_at?: string | null;
  score?: number | null;
  grade?: string | null;
  attempt?: number | null;
  late?: boolean;
  excused?: boolean;
  missing?: boolean;
  points_deducted?: number | null;
}

export interface CanvasUser {
  id: number;
  name?: string;
}
