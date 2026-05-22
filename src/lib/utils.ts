import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isNumericColumnType(columnType: string | undefined) {
  if (!columnType) return false

  return /\b(?:u?int(?:8|16|32|64|128)?|u?tinyint|u?smallint|u?integer|u?bigint|hugeint|uhugeint|float|double|real|decimal|numeric)\b/i.test(
    columnType
  )
}
