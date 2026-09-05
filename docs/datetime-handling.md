# Date/Time Handling: Node (exiftool-vendored) vs Go (go-exiftool)

This document explains how capture date/time and timezone are derived from media
metadata, what the Node.js server got "for free" from `exiftool-vendored`, why
the Go port needed explicit code to match it, and the design chosen in Go.

It is the reference for the `internal/utils/exifdate.go` helper and the
date/time logic in `internal/media/exif.go`.

## Why this is needed

The core problem is a difference between how images and videos record their
capture time:

- **Images (JPEG/HEIC)** store the capture time in EXIF `DateTimeOriginal`, and
  modern devices also record the UTC offset (`OffsetTimeOriginal`, e.g.
  `-04:00`). So an image's timestamp is unambiguous -- it carries the local time
  and its offset.
- **Videos (MP4/QuickTime)** store the capture time in `QuickTime:CreateDate`,
  which by container specification is in **UTC** and has **no timezone field**.
  exiftool therefore reports it as a naive string like `2026:09:03 11:10:23`
  with no offset.

This means a video timestamp, taken at face value, is ambiguous and (if treated
as local time) simply wrong -- it is really UTC. To place a video in the correct
day/album and show the correct local capture time, we must:

1. know that a naive video timestamp is UTC, and
2. convert it to the capture location's timezone when we can determine it (from
   the video's GPS coordinates).

Neither step is done by exiftool automatically (see
[What exiftool does and does NOT do](#what-exiftool-the-tool-does-and-does-not-do)),
so the application has to handle it. The rest of this document covers how the
Node server got some of this "for free" from its library, and how the Go port
implements it explicitly.

## The two wrapper libraries are not equivalent

Both servers shell out to the same external `exiftool`, but through very
different wrappers:

- **Node: `exiftool-vendored`** parses each date tag into a rich `ExifDateTime`
  object with structured fields (`year`, `month`, ..., `tzoffsetMinutes`,
  `zoneName`, `rawValue`) and renders ISO-8601 via `toString()`. It also applies
  several *policies* on top of raw exiftool output (see below).
- **Go: `barasher/go-exiftool`** is a thin wrapper. It returns tags as raw
  strings in a `map[string]interface{}` (`GetString`, `GetInt`, ...). It has no
  date type, no timezone resolution, and no policies.

So behaviors that "just worked" in Node because the library did them must be
implemented explicitly in Go.

## exiftool's raw date formats (what go-exiftool hands us)

All exiftool datetimes use colon date separators and are **not** valid SQLite
datetimes as-is:

| Field | Example | Notes |
|-------|---------|-------|
| `EXIF:DateTimeOriginal` / `EXIF:CreateDate` | `2025:09:11 18:02:17` | no subseconds, no tz |
| `Composite:SubSecDateTimeOriginal` / `SubSecCreateDate` | `2025:09:11 18:02:17.774-04:00` | subseconds + tz (images with offset/GPS) |
| `File:FileModifyDate` | `2025:09:15 11:33:32-04:00` | local + tz, no subseconds |
| `QuickTime:CreateDate` (video) | `2026:08:24 16:25:17` | **UTC by convention, but reported naive (no offset)** |
| `GPSDateTime` | `2025:09:11 22:01:39Z` | UTC |

`SubSec*` composites are exiftool combining the base EXIF date with
`OffsetTimeOriginal` or a GPS-derived offset. Videos typically have **no**
`SubSec*` composite.

## What Node got "for free" from exiftool-vendored

### 1. Structured components and ISO rendering

`ExifDateTime` exposes `.year/.month/.day/.hour/...` and `.tzoffsetMinutes`
directly, so Node builds `capture_date`, `capture_time`, `capture_tz_offset`
from object fields with no string parsing, and `captured_at`/`exif_*_ref` via
`toString()` (ISO-8601 with subseconds + offset).

### 2. Videos default to UTC (`defaultVideosToUTC`)

QuickTime/MP4 `CreateDate` is stored in UTC by device convention but reported
without an offset. `exiftool-vendored` sets a default that interprets naive
video timestamps as UTC, and -- when a real zone can be resolved -- expresses the
instant in that zone. This behavior was requested and added via
[exiftool-vendored issue #113](https://github.com/photostructure/exiftool-vendored.js/issues/113).

## What exiftool (the tool) does and does NOT do

Tested with exiftool 13.59 and confirmed against the exiftool author's forum:

- `-api geolocation=1` **derives** `GeolocationTimeZone` (e.g. `Asia/Kolkata`)
  from GPS coordinates -- a lookup only. It does **NOT** apply that zone to any
  timestamp; QuickTime dates stay naive.
- `-api QuickTimeUTC=1` makes exiftool assume QuickTime dates are UTC and convert
  them to **the computer's local time zone** -- not the capture location's zone.
- To convert to a *specific* zone you must pass it explicitly
  (`-api TimeZone=Asia/Kolkata`), or an offset.
- There is **no** exiftool option (in 13.59 or newer) that automatically feeds
  the GPS-derived `GeolocationTimeZone` into the QuickTimeUTC conversion. It is a
  repeatedly-requested but unimplemented feature. (See exiftool forum: "Update
  Timestamps based on 'Geolocation Time Zone'", "Determine Time Zone
  automatically?" -- both open requests.)

Quotes from the exiftool author's forum:

> "by default ExifTool does not assume a time zone for these values. However, if
> the QuickTimeUTC API option is set, then ExifTool will assume these values are
> properly stored as UTC, and will convert them to local time when extracting."

> "This will work correctly as long as the video was taken in the same time zone
> as the computer you are currently using. If not, you will have to add the time
> zone..."

**Conclusion:** the "video -> capture-local time" behavior is *not* something
exiftool provides in a single pass. `exiftool-vendored` implements it in the
library (read `GeolocationTimeZone`, then construct the date in that zone). The
Go port must do the same.

## Go design

### The `exifdate` helper (`internal/utils/exifdate.go`)

A minimal, dependency-free stand-in for `ExifDateTime`. It is NOT a full port --
it does not re-implement timezone rules (that is delegated to Go's stdlib `time`
and the OS tzdata) or GPS-to-zone lookup (that stays in exiftool).

```go
type ExifDateTime struct {
    Year, Month, Day, Hour, Minute, Second int
    Nanosecond      int
    HasSubsec       bool
    TzOffsetMinutes *int   // nil = no timezone in the source (floating)
}

ParseExifDate(s string) (ExifDateTime, bool)   // one parser for all exiftool formats
(d) ToISO() string            // 2025-09-11T18:02:17.774-04:00 (subsec/tz only when present)
(d) ToSQLiteLocal() string    // 2025-09-11 18:02:17 (drops tz/subsec; matches datetime('now','localtime'))
(d) Unix() int64
(d) AsUTC() ExifDateTime      // stamp a naive value as UTC (offset 0), no shift
(d) In(loc *time.Location) ExifDateTime  // convert the instant into loc, recompute components + offset
(d) DateString()/TimeString()/TzOffsetString()
```

This one helper replaced several ad-hoc parsers that existed before
(`exifDateToISO`, `parseCaptureDateTime`, `parseTzOffset`,
`parseDateToCaptureDateTime`, `normalizeExifDateToSQLite`) and is now used for
**every** date field: `captured_at`, `capture_*`, `exif_*_ref`,
`file_modified_at`/`trashed_at`, and mtime parsing for change detection.

**UTC rendering:** `ToISO()` renders a zero offset as `Z` (e.g.
`2026-09-03T11:10:23Z`), matching exiftool-vendored's ISO output; non-zero
offsets use `+HH:MM`/`-HH:MM`. The separate `capture_tz_offset` column is
rendered via `TzOffsetString()` and intentionally stays `+00:00` for UTC (also
matching Node, where `captured_at` uses `Z` but `capture_tz_offset` is `+00:00`).

### Field derivation (`internal/media/exif.go`)

1. **`captured_at` / `CaptureDateTime`**: prefer `Composite:SubSecDateTimeOriginal`
   -> `SubSecCreateDate` (tz-aware), falling back to plain `EXIF`/`QuickTime`
   dates. Parsed via `ParseExifDate`, rendered ISO for `captured_at`.

2. **`exif_datetime_original_ref` / `exif_create_date_ref`**: sourced from the
   **Composite SubSec** fields (falling back to plain EXIF), rendered ISO -- so
   they match Node's `ExifDateTime.toString()` output (subseconds + tz). Earlier
   the Go port stored the raw plain-EXIF string here, which was the main
   `exif_*_ref` diff vs Node.

3. **Video timezone (the `defaultVideosToUTC` equivalent)** -- for
   `mediatype == "video"` only:
   - If the parsed capture value has **no** offset (naive), treat it as UTC
     (`AsUTC`).
   - If `ExifTool:GeolocationTimeZone` is present (GPS-derived), shift the UTC
     instant into that IANA zone via `In(time.LoadLocation(zone))`, so
     `captured_at`, `capture_*`, and (critically) `album_date` reflect the
     **local capture date/time**.
   - Otherwise keep it UTC: `captured_at`/`exif_*_ref` render as `...Z`,
     `capture_tz_offset = "+00:00"`, `capture_tz_name = "UTC"`.
   - A video that already carries an explicit offset, and all still-images, are
     left untouched.

   Implemented in `resolveVideoDate(dt, isVideo, geoTZ)` and applied to both
   `captured_at`/`CaptureDateTime` and the `exif_*_ref` fields.

### Why not push the conversion into exiftool?

The only exiftool-side alternative is a **second pass per video** with
`-api QuickTimeUTC=1 -api TimeZone=<derived zone>`. That requires an extra
exiftool invocation (the persistent `stay_open` process is initialized with a
fixed set of `-api` flags), for the same result Go's stdlib `time.In()` produces
in-process from data we already have. So the in-code conversion is the simpler,
faster choice and mirrors what exiftool-vendored does internally.

### `album_date` and the local-timezone requirement

`album_date` (intake folder placement) is derived from the
`CaptureDateTime.Year/Month/Day` wall-clock. Because of the video handling above:

- **GPS video** -> wall-clock is the capture-local time -> `album_date` is the
  local date (verified with a Bengaluru video: UTC `16:25` -> IST `21:55+05:30`,
  and a US video: UTC `12:14` -> EDT `08:14-04:00`).
- **No-GPS video** -> no zone knowable -> UTC wall-clock is used (matches Node;
  assuming the server's local zone would be wrong for travel videos).
- Cross-midnight correctness is covered by unit tests (UTC `02:00` on the 3rd ->
  local `22:00` on the 2nd in EDT).

## Known remaining datetime differences (cosmetic)

- **`file_modified_at`**: Node stores UTC ISO-8601 with `Z`; Go stores the raw
  exiftool local+tz string. Same instant, different representation.

## Verification

Datetime behavior was verified by indexing the same media in isolated Node and
Go environments and diffing the `metadata` tables keyed on filename. Video
timezone handling was verified against real device videos (no-GPS, US GPS, and
India GPS) with full Node/Go parity on `captured_at`, `capture_*`, and
`album_date`. See `internal/utils/exifdate_test.go` for the timezone-conversion
unit tests.
