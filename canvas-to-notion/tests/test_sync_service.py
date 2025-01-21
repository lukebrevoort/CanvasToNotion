import unittest
from unittest.mock import patch, MagicMock
from src.sync_service import sync_assignments

class TestSyncService(unittest.TestCase):

    @patch('src.canvas_api.get_updated_assignments')
    @patch('src.notion_api.update_notion_assignment')
    def test_sync_assignments(self, mock_update_notion_assignment, mock_get_updated_assignments):
        # Arrange
        mock_get_updated_assignments.return_value = [
            {'id': 1, 'name': 'Assignment 1', 'due_date': '2023-10-01', 'status': 'not_submitted'},
            {'id': 2, 'name': 'Assignment 2', 'due_date': '2023-10-15', 'status': 'submitted'}
        ]
        
        # Act
        sync_assignments()

        # Assert
        mock_get_updated_assignments.assert_called_once()
        mock_update_notion_assignment.assert_any_call(1, 'Assignment 1', '2023-10-01', 'not_submitted')
        mock_update_notion_assignment.assert_any_call(2, 'Assignment 2', '2023-10-15', 'submitted')

if __name__ == '__main__':
    unittest.main()