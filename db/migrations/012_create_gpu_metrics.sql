-- 012_create_gpu_metrics.sql
-- Stores GPU utilization snapshots from nvidia-smi for resource manager

CREATE TABLE IF NOT EXISTS gpu_metrics (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gpu_index         integer NOT NULL,
  gpu_name          text NOT NULL,
  memory_used_mb    integer NOT NULL,
  memory_free_mb    integer NOT NULL,
  memory_total_mb   integer NOT NULL,
  utilization_percent integer NOT NULL,
  temperature_c     integer,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gpu_metrics_recorded_at ON gpu_metrics (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_gpu_metrics_gpu_index   ON gpu_metrics (gpu_index, recorded_at DESC);

COMMENT ON TABLE gpu_metrics IS
  'Continuous GPU utilization metrics sampled every 10 seconds. Used by the resource manager to make intelligent model routing decisions and detect resource pressure.';
