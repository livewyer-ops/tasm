-- Flow collection membership, one row per flow_collection_ids entry, kept in
-- step with tamoss_flows by triggers so membership filters can use indexes.
CREATE TABLE IF NOT EXISTS tamoss_flow_collection_members (
    parent_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    child_id TEXT NOT NULL,
    PRIMARY KEY(parent_id, position)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_tamoss_flow_collection_members_child
ON tamoss_flow_collection_members(child_id, parent_id);
CREATE TRIGGER IF NOT EXISTS tamoss_flow_members_insert AFTER INSERT ON tamoss_flows
BEGIN
    INSERT INTO tamoss_flow_collection_members(parent_id,position,child_id)
    SELECT NEW.id, member.key, member.value FROM json_each(NEW.flow_collection_ids) AS member;
END;
-- Every flow UPSERT names flow_collection_ids, so compare values to skip unchanged collections.
CREATE TRIGGER IF NOT EXISTS tamoss_flow_members_update AFTER UPDATE OF id, flow_collection_ids ON tamoss_flows
WHEN OLD.id IS NOT NEW.id OR OLD.flow_collection_ids IS NOT NEW.flow_collection_ids
BEGIN
    DELETE FROM tamoss_flow_collection_members WHERE parent_id=OLD.id;
    INSERT INTO tamoss_flow_collection_members(parent_id,position,child_id)
    SELECT NEW.id, member.key, member.value FROM json_each(NEW.flow_collection_ids) AS member;
END;
CREATE TRIGGER IF NOT EXISTS tamoss_flow_members_delete AFTER DELETE ON tamoss_flows
BEGIN
    DELETE FROM tamoss_flow_collection_members WHERE parent_id=OLD.id;
END;

DELETE FROM tamoss_flow_collection_members;
INSERT INTO tamoss_flow_collection_members(parent_id,position,child_id)
SELECT flow.id, member.key, member.value FROM tamoss_flows AS flow, json_each(flow.flow_collection_ids) AS member;
