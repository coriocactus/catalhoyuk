#!/bin/bash

# Function to calculate days until a given date
days_until() {
  local target_date="$1"
  local current_timestamp=$(date +%s)
  local target_timestamp=$(date -j -f "%Y-%m-%d" "$target_date" +%s 2>/dev/null)

  if [ $? -ne 0 ]; then
    echo "Error: Invalid date format for '$target_date'"
    return 1
  fi

  local diff_seconds=$((target_timestamp - current_timestamp))
  local diff_days=$((diff_seconds / 86400))

  echo "$diff_days"
}

# Function to get next occurrence of a birthday
next_birthday() {
  local birth_date="$1"
  local current_year=$(date +%Y)
  local birth_month_day=$(date -j -f "%Y-%m-%d" "$birth_date" +%m-%d)

  local this_year_birthday="${current_year}-${birth_month_day}"
  local days=$(days_until "$this_year_birthday")

  if [ $days -lt 0 ]; then
    local next_year=$((current_year + 1))
    echo "${next_year}-${birth_month_day}"
  else
    echo "$this_year_birthday"
  fi
}

# Format: "YYYY-MM-DD:Label:Type"
# Types: "date" (one-time) or "birthday" (recurring)
dates=(
  "1996-11-06:30th Birthday:birthday"
)

for entry in "${dates[@]}"; do
  IFS=':' read -r date_part label type <<< "$entry"

  if [ "$type" = "birthday" ]; then
    next_date=$(next_birthday "$date_part")
    days=$(days_until "$next_date")

    birth_year=$(echo "$date_part" | cut -d'-' -f1)
    next_year=$(echo "$next_date" | cut -d'-' -f1)
    age=$((next_year - birth_year))

    echo "$label (Age $age on $next_date): $days days"
  else
    days=$(days_until "$date_part")

    if [ $? -eq 0 ]; then
      if [ $days -gt 0 ]; then
        echo "$label ($date_part): $days days"
      elif [ $days -eq 0 ]; then
        echo "$label ($date_part): Today!"
      else
        echo "$label ($date_part): $((days * -1)) days ago"
      fi
    fi
  fi
done
