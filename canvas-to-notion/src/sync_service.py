import time
import schedule
from datetime import datetime
from .canvas_api import CanvasAPI
from .notion_api import NotionAPI
from .utils.config import SYNC_INTERVAL
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class SyncService:
    def __init__(self):
        self.canvas_api = CanvasAPI()
        self.notion_api = NotionAPI()
        self.last_sync = None

    def sync(self):
        try:
            logger.info(f"Starting sync at {datetime.now()}")
            assignments = self.canvas_api.get_updated_assignments(self.last_sync)
            
            for assignment in assignments:
                self.notion_api.create_or_update_assignment(assignment)
                logger.info(f"Synced assignment: {assignment.name}")
            
            self.last_sync = datetime.now()
            logger.info(f"Sync completed at {self.last_sync}")
        except Exception as e:
            logger.error(f"Sync failed: {str(e)}")

def main():
    sync_service = SyncService()
    
    # Initial sync
    sync_service.sync()
    
    # Schedule regular syncs
    schedule.every(SYNC_INTERVAL).seconds.do(sync_service.sync)
    
    # Keep the script running
    while True:
        schedule.run_pending()
        time.sleep(1)

if __name__ == "__main__":
    main()