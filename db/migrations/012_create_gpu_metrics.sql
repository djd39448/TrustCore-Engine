-- 012_create_gpu_metrics.sql
-- Stores GPU utilization snapshots from nvidia-smi for resource manager

CREATE TABLE IF NOT EXISTS gpu_metrics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gpu_index    integer NOT NULL,
  gpu_name     text NOT NULL,
  memory_used  integer NOT NULL,   -- MiB
  memory_free  integer NOT NULL,   -- MiB
  memory_total integer NOT NULL,   -- MiB
  utilization  integer NOT NULL,   -- percent 0-100
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gpu_metrics_recorded_at ON gpu_metrics (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_gpu_metrics_gpu_index   ON gpu_metrics (gpu_index, recorded_at DESC);
