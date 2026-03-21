-- 007_add_consolidation_fk.sql
-- Add foreign key from unified_memory.consolidation_id to memory_consolidations
-- (Resolves circular FK dependency between unified_memory and memory_consolidations)

ALTER TABLE unified_memory
ADD CONSTRAINT fk_unified_memory_consolidation
FOREIGN KEY (consolidation_id) REFERENCES memory_consolidations(id) ON DELETE SET NULL;

CREATE INDEX idx_unified_memory_consolidation ON unified_memory (consolidation_id);

COMMENT ON CONSTRAINT fk_unified_memory_consolidation ON unified_memory IS 'Backlink: if this memory was consolidated, which rollup record absorbed it?';
