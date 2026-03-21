#!/bin/bash
set -e

# Load environment
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Ensure DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "Error: DATABASE_URL not set. Did you create .env?"
  exit 1
fi

echo "🚀 Running migrations..."
echo "Database: $DATABASE_URL"

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(dirname "$SCRIPT_DIR")/db"
MIGRATIONS_DIR="$DB_DIR/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Error: migrations directory not found at $MIGRATIONS_DIR"
  exit 1
fi

# Run each migration in order
for migration_file in "$MIGRATIONS_DIR"/*.sql; do
  if [ -f "$migration_file" ]; then
    filename=$(basename "$migration_file")
    echo "📝 Running: $filename"
    
    # Execute the migration
    psql "$DATABASE_URL" -f "$migration_file" -v ON_ERROR_STOP=1 || {
      echo "❌ Migration failed: $filename"
      exit 1
    }
    
    echo "✅ Completed: $filename"
  fi
done

echo ""
echo "✨ All migrations completed successfully!"
echo ""
echo "Next: psql \$DATABASE_URL -f db/seed.sql"
