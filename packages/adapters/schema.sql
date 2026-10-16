CREATE TABLE IF NOT EXISTS yumunio_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS yumunio_pages (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  parent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed_at TEXT,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0 AND epoch <= 9007199254740991),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES yumunio_pages(workspace_id, id)
);
CREATE INDEX IF NOT EXISTS yumunio_pages_parent ON yumunio_pages(workspace_id, parent_id);
CREATE TABLE IF NOT EXISTS yumunio_documents (
  workspace_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1 AND version <= 9007199254740991),
  blocks_json TEXT NOT NULL CHECK (json_valid(blocks_json) AND json_type(blocks_json) = 'array'),
  updated_at TEXT NOT NULL,
  cause TEXT NOT NULL DEFAULT 'edit' CHECK (cause IN ('edit', 'hierarchy')),
  PRIMARY KEY (workspace_id, page_id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES yumunio_pages(workspace_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS yumunio_collections (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  properties_json TEXT NOT NULL CHECK (json_valid(properties_json) AND json_type(properties_json) = 'array'),
  records_json TEXT NOT NULL CHECK (json_valid(records_json) AND json_type(records_json) = 'array'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0 AND revision <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE VIEW IF NOT EXISTS yumunio_active_pages AS
WITH RECURSIVE hidden(workspace_id, id) AS (
  SELECT workspace_id, id FROM yumunio_pages WHERE trashed_at IS NOT NULL
  UNION
  SELECT child.workspace_id, child.id FROM yumunio_pages child
  JOIN hidden parent ON child.workspace_id = parent.workspace_id AND child.parent_id = parent.id
)
SELECT page.* FROM yumunio_pages page
WHERE NOT EXISTS (SELECT 1 FROM hidden WHERE hidden.workspace_id = page.workspace_id AND hidden.id = page.id);

CREATE TRIGGER IF NOT EXISTS yumunio_page_insert_parent
BEFORE INSERT ON yumunio_pages
BEGIN
  SELECT RAISE(ABORT, 'YUMUNIO_HIERARCHY_CYCLE') WHERE NEW.parent_id = NEW.id;
  SELECT RAISE(ABORT, 'YUMUNIO_NOT_FOUND') WHERE NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM yumunio_pages WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
  );
  SELECT RAISE(ABORT, 'YUMUNIO_DESTINATION_UNAVAILABLE') WHERE NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM yumunio_active_pages WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
  );
END;
CREATE TRIGGER IF NOT EXISTS yumunio_page_identity
BEFORE UPDATE OF workspace_id, id ON yumunio_pages
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'YUMUNIO_INVALID_INPUT');
END;
CREATE TRIGGER IF NOT EXISTS yumunio_page_update_parent
BEFORE UPDATE OF parent_id ON yumunio_pages
WHEN NEW.parent_id IS NOT OLD.parent_id
BEGIN
  SELECT RAISE(ABORT, 'YUMUNIO_HIERARCHY_CYCLE') WHERE EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT NEW.id, NEW.parent_id
      UNION
      SELECT parent.id, parent.parent_id FROM yumunio_pages parent
      JOIN ancestors child ON parent.id = child.parent_id AND parent.workspace_id = NEW.workspace_id
    ) SELECT 1 FROM ancestors WHERE parent_id = NEW.id
  );
  SELECT RAISE(ABORT, 'YUMUNIO_NOT_FOUND') WHERE NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM yumunio_pages WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
  );
  SELECT RAISE(ABORT, 'YUMUNIO_DESTINATION_UNAVAILABLE') WHERE NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM yumunio_active_pages WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
  );
END;
CREATE TRIGGER IF NOT EXISTS yumunio_page_epoch_guard
BEFORE UPDATE OF epoch ON yumunio_pages
WHEN NEW.epoch IS NOT OLD.epoch
BEGIN
  SELECT RAISE(ABORT, 'YUMUNIO_VERSION_CONFLICT') WHERE OLD.epoch = 9007199254740991 OR NEW.epoch != OLD.epoch + 1;
  SELECT RAISE(ABORT, 'YUMUNIO_DESTINATION_UNAVAILABLE') WHERE NEW.trashed_at IS NULL AND NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM yumunio_active_pages WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
  );
  SELECT RAISE(ABORT, 'YUMUNIO_VERSION_CONFLICT') WHERE EXISTS (
    WITH RECURSIVE subtree(id) AS (
      SELECT OLD.id
      UNION
      SELECT child.id FROM yumunio_pages child JOIN subtree parent ON child.parent_id = parent.id
      WHERE child.workspace_id = OLD.workspace_id
    ) SELECT 1 FROM yumunio_documents document JOIN subtree ON subtree.id = document.page_id
      WHERE document.workspace_id = OLD.workspace_id AND document.version = 9007199254740991
  );
END;
CREATE TRIGGER IF NOT EXISTS yumunio_page_epoch_documents
AFTER UPDATE OF epoch ON yumunio_pages
WHEN NEW.epoch IS NOT OLD.epoch
BEGIN
  UPDATE yumunio_documents SET version = version + 1, updated_at = NEW.updated_at, cause = 'hierarchy'
  WHERE workspace_id = NEW.workspace_id AND page_id IN (
    WITH RECURSIVE subtree(id) AS (
      SELECT NEW.id
      UNION
      SELECT child.id FROM yumunio_pages child JOIN subtree parent ON child.parent_id = parent.id
      WHERE child.workspace_id = NEW.workspace_id
    ) SELECT id FROM subtree
  );
END;
CREATE TRIGGER IF NOT EXISTS yumunio_document_identity
BEFORE UPDATE OF workspace_id, page_id ON yumunio_documents
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.page_id IS NOT OLD.page_id
BEGIN
  SELECT RAISE(ABORT, 'YUMUNIO_INVALID_INPUT');
END;
CREATE TRIGGER IF NOT EXISTS yumunio_document_version
BEFORE UPDATE ON yumunio_documents
BEGIN
  SELECT RAISE(ABORT, 'YUMUNIO_VERSION_CONFLICT') WHERE OLD.version = 9007199254740991 OR NEW.version != OLD.version + 1;
  SELECT RAISE(ABORT, 'YUMUNIO_NOT_FOUND') WHERE NEW.cause = 'edit' AND NOT EXISTS (
    SELECT 1 FROM yumunio_active_pages WHERE workspace_id = NEW.workspace_id AND id = NEW.page_id
  );
END;
CREATE TRIGGER IF NOT EXISTS yumunio_document_touch_page
AFTER UPDATE ON yumunio_documents
WHEN NEW.cause = 'edit'
BEGIN
  UPDATE yumunio_pages SET updated_at = NEW.updated_at WHERE workspace_id = NEW.workspace_id AND id = NEW.page_id;
END;
CREATE TRIGGER IF NOT EXISTS yumunio_collection_identity
BEFORE UPDATE OF workspace_id, id ON yumunio_collections
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'YUMUNIO_INVALID_INPUT');
END;
INSERT OR IGNORE INTO yumunio_schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
