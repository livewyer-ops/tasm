# TAMS Playpen

Open the [Playpen](https://playpen.tams.lwy.sh/). **Start tour** creates a separate example and walks through an edit. To build your own, choose **Explore on my own**.

## Build a timeline

1. Create a source and add a video or audio flow.
2. Drag a sample from the library onto a matching flow, or choose **Add sample at playhead**. Drop onto an existing clip to insert at the nearest segment boundary. Later clips in that flow shift by the inserted duration.
3. Use **Flows** to move whole clips or **Segments** to move individual segments. Select an item to enter an exact start time or remove it.
4. Choose **Save** to publish the arrangement. Preview and range queries use the last saved version. Unsaved edits survive a reload. **Discard** restores the saved version.

A save reuses existing objects and publishes replacement flows together. A failed save leaves the draft available to retry. If another tab has changed the source, discard the stale draft and reload before editing.

## Import media

Drop a file into **Sample library** or choose **Import media**. The Playpen accepts one MP4, MOV, TS, M4A or AAC file at a time, up to 100 MiB, with at most one H.264 video track and one AAC audio track. Each track becomes a library sample. Use separate flows for clips with incompatible media settings.

Importing stores samples in this browser. **Save** uploads the samples used on the timeline to its local TAMS store. Removing a library sample preserves media already saved to a flow.

## Play and inspect

Choose the video and audio flows below Preview. Gaps play as black or silence. **Query & read** lists the matching segments and objects. **Play range** plays the selected interval.

**Media store** shows which objects each segment references. **Check storage** verifies their sizes without downloading them. **API activity** shows the requests and responses for each edit. To pause before a write, enable **Step through API calls** under **API steps**, then use **Ingest controls** to advance or cancel.

Select a request or resource ID to open its curl command in **Terminal**. Running a command sends a real request to this browser's store. Writes change stored data.

**Reset** deletes the Playpen's local media, drafts and settings. Close other Playpen tabs first.

To move a selected clip or segment with the keyboard, choose its destination flow, enter a start time and activate **Move**. Delete and Backspace remove the selection when focus is on the timeline or its edit buttons. When placing both tracks of an imported file at the same time, Playpen preserves their relative audio and video start times.
