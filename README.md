# Canvas to Notion Assignment Sync

An automated system that seamlessly syncs Canvas assignments to a Notion database, running automatically on system startup via launchctl on macOS.

## Overview

This application monitors Canvas for new assignments and updates a Notion database in real-time. It maintains assignment details including:
- Due dates
- Course information
- Assignment descriptions
- Submission status
- Priority levels
- Assignment URLs

## System Requirements

- macOS (for launchctl automation)
- Python 3.8+
- Canvas API access
- Notion API access and integration

## Setup Instructions

1. Clone the repository:
   ```
   git clone <repository-url>
   cd assignmentTracker
   ```

2. Create a virtual environment:
   ```
   python -m venv venv
   source venv/bin/activate
   ```

3. Install dependencies:
   ```
   pip install -r requirements.txt
   ```

4. Configure environment variables in `.env`:
   ```
   CANVAS_TOKEN=<your_canvas_token>
   CANVAS_URL=<your_canvas_url>
   NOTION_TOKEN=<your_notion_token>
   NOTION_DATABASE_ID=<your_notion_database_id>
   ```

5. Set up launchctl automation:
   ```
   # Copy the plist file to LaunchAgents
   cp com.assignmenttracker.sync.plist ~/Library/LaunchAgents/
   
   # Load the service
   launchctl load ~/Library/LaunchAgents/com.assignmenttracker.sync.plist
   ```

## LaunchCtl Configuration

The service is configured to:
- Start automatically when you log in
- Run the sync script every 15 minutes
- Restart automatically if it fails
- Log output to `/Users/[username]/Library/Logs/assignmentTracker/sync.log`

To manually manage the service:
```bash
# Check status
launchctl list | grep assignmenttracker

# Stop service
launchctl unload ~/Library/LaunchAgents/com.assignmenttracker.sync.plist

# Start service
launchctl load ~/Library/LaunchAgents/com.assignmenttracker.sync.plist
```

## Manual Usage

To run the sync process manually:
```bash
python src/sync_service.py
```

## Troubleshooting

Check the logs at:
```
~/Library/Logs/assignmentTracker/sync.log
```

## License

This project is licensed under the MIT License.