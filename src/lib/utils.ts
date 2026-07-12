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

export function isTimestampColumnType(columnType: string | undefined) {
  if (!columnType) return false

  return /\btimestamp\b/i.test(columnType)
}

export function formatQueryCellValue(
  value: unknown,
  columnType: string | undefined,
  options?: { renderTimestampsAsIso?: boolean; formatValue?: (value: unknown) => string }
) {
  if (value === null || value === undefined) return ""

  if (options?.renderTimestampsAsIso) {
    const isoTimestamp = formatDuckDbTimestampAsIso(value, columnType)
    if (isoTimestamp) return isoTimestamp
  }

  return options?.formatValue?.(value) ?? String(value)
}

export function hasDuckDbTimestampValues(result: {
  column_types: string[]
  rows: unknown[][]
}) {
  return result.column_types.some(isTimestampColumnType) || result.rows.some((row) =>
    row.some((value) => typeof value === "string" && parseDuckDbTimestampDebugString(value))
  )
}

const DUCKDB_TIMESTAMP_PATTERN = /^Timestamp\((Second|Millisecond|Microsecond|Nanosecond), (-?\d+)\)$/
type DuckDbTimestampUnit = "Second" | "Millisecond" | "Microsecond" | "Nanosecond"

function formatDuckDbTimestampAsIso(value: unknown, columnType: string | undefined) {
  if (typeof value !== "string") return null
  if (!isTimestampColumnType(columnType) && !parseDuckDbTimestampDebugString(value)) return null

  const parsed = parseDuckDbTimestampDebugString(value)
  if (!parsed) return null

  const scaleByUnit = {
    Second: 1_000_000_000n,
    Millisecond: 1_000_000n,
    Microsecond: 1_000n,
    Nanosecond: 1n,
  } satisfies Record<DuckDbTimestampUnit, bigint>

  const totalNanos = parsed.value * scaleByUnit[parsed.unit]
  const nanosPerSecond = 1_000_000_000n
  let seconds = totalNanos / nanosPerSecond
  let nanos = totalNanos % nanosPerSecond

  if (nanos < 0) {
    seconds -= 1n
    nanos += nanosPerSecond
  }

  const milliseconds = seconds * 1000n + nanos / 1_000_000n
  if (
    milliseconds < BigInt(Number.MIN_SAFE_INTEGER) ||
    milliseconds > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return value
  }

  const date = new Date(Number(milliseconds))
  if (Number.isNaN(date.getTime())) return value

  const fractional = nanos === 0n ? "" : `.${nanos.toString().padStart(9, "0").replace(/0+$/, "")}`
  return date.toISOString().replace(/\.\d{3}Z$/, `${fractional}Z`)
}

function parseDuckDbTimestampDebugString(value: string) {
  const match = DUCKDB_TIMESTAMP_PATTERN.exec(value)
  if (!match) return null

  return {
    unit: match[1] as DuckDbTimestampUnit,
    value: BigInt(match[2]),
  }
}
