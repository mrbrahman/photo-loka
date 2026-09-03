package utils

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ExifDateTime is a parsed date/time value originating from exiftool output.
// It is a minimal, dependency-free stand-in for the ExifDateTime object that
// exiftool-vendored provides in the Node.js server: it holds the parsed
// components plus optional subseconds and timezone offset, and knows how to
// render itself in the formats the various DB columns expect.
//
// TzOffsetMinutes is nil when the source string carried no timezone (a
// "floating" local time, e.g. a bare EXIF:DateTimeOriginal). HasSubsec
// distinguishes "no fractional seconds" from ".000".
type ExifDateTime struct {
	Year, Month, Day int
	Hour, Minute, Second int
	Nanosecond      int
	HasSubsec       bool
	TzOffsetMinutes *int
}

// ParseExifDate parses the date/time formats emitted by exiftool (and the
// already-ISO variants produced elsewhere). It accepts:
//   - "YYYY:MM:DD HH:MM:SS"                 (exiftool native, no tz)
//   - "YYYY:MM:DD HH:MM:SS.sss"             (with subseconds)
//   - "YYYY:MM:DD HH:MM:SS[.sss](+|-)HH:MM" (with tz offset)
//   - "YYYY:MM:DD HH:MM:SS[.sss](+|-)HHMM"  (offset without colon)
//   - "YYYY:MM:DD HH:MM:SS[.sss]Z"          (UTC)
//   - the same with '-' date separators and/or 'T' between date and time
//
// It returns ok=false for empty/zero/garbage values (e.g. "0000:00:00 00:00:00").
func ParseExifDate(s string) (ExifDateTime, bool) {
	var d ExifDateTime
	s = strings.TrimSpace(s)
	if s == "" || strings.HasPrefix(s, "0000") {
		return d, false
	}

	// Split date and time on the first space or 'T'.
	sep := strings.IndexAny(s, " T")
	if sep < 0 {
		return d, false
	}
	datePart := s[:sep]
	rest := s[sep+1:]

	// Date: allow ':' or '-' separators.
	dp := strings.FieldsFunc(datePart, func(r rune) bool { return r == ':' || r == '-' })
	if len(dp) != 3 {
		return d, false
	}
	var err error
	if d.Year, err = strconv.Atoi(dp[0]); err != nil {
		return d, false
	}
	if d.Month, err = strconv.Atoi(dp[1]); err != nil {
		return d, false
	}
	if d.Day, err = strconv.Atoi(dp[2]); err != nil {
		return d, false
	}

	// Separate the timezone suffix from the time-of-day, if present.
	var tz string
	if strings.HasSuffix(rest, "Z") {
		tz = "Z"
		rest = strings.TrimSuffix(rest, "Z")
	} else {
		// Find a '+' or '-' that introduces the offset. Scan from the end so we
		// do not confuse it with anything earlier in the string.
		for i := len(rest) - 1; i >= 0; i-- {
			if rest[i] == '+' || rest[i] == '-' {
				tz = rest[i:]
				rest = rest[:i]
				break
			}
		}
	}

	// Time: "HH:MM:SS" with optional ".frac".
	timePart := rest
	frac := ""
	if dot := strings.IndexByte(timePart, '.'); dot >= 0 {
		frac = timePart[dot+1:]
		timePart = timePart[:dot]
	}
	tp := strings.Split(timePart, ":")
	if len(tp) != 3 {
		return d, false
	}
	if d.Hour, err = strconv.Atoi(tp[0]); err != nil {
		return d, false
	}
	if d.Minute, err = strconv.Atoi(tp[1]); err != nil {
		return d, false
	}
	if d.Second, err = strconv.Atoi(tp[2]); err != nil {
		return d, false
	}

	if frac != "" {
		// Normalize the fractional string to nanoseconds (pad/truncate to 9).
		if len(frac) > 9 {
			frac = frac[:9]
		}
		padded := frac + strings.Repeat("0", 9-len(frac))
		if ns, e := strconv.Atoi(padded); e == nil {
			d.Nanosecond = ns
			d.HasSubsec = true
		}
	}

	if tz != "" {
		if off, ok := parseTzToMinutes(tz); ok {
			d.TzOffsetMinutes = &off
		}
	}

	if d.Year == 0 && d.Month == 0 && d.Day == 0 {
		return d, false
	}
	return d, true
}

// parseTzToMinutes parses "Z", "+05:30", "-04:00", "+0530" into signed minutes.
func parseTzToMinutes(tz string) (int, bool) {
	if tz == "Z" {
		return 0, true
	}
	if len(tz) < 3 {
		return 0, false
	}
	sign := 1
	switch tz[0] {
	case '+':
		sign = 1
	case '-':
		sign = -1
	default:
		return 0, false
	}
	body := tz[1:]
	var hours, minutes int
	var err error
	if strings.Contains(body, ":") {
		parts := strings.SplitN(body, ":", 2)
		if hours, err = strconv.Atoi(parts[0]); err != nil {
			return 0, false
		}
		if minutes, err = strconv.Atoi(parts[1]); err != nil {
			return 0, false
		}
	} else if len(body) >= 4 {
		if hours, err = strconv.Atoi(body[:2]); err != nil {
			return 0, false
		}
		if minutes, err = strconv.Atoi(body[2:4]); err != nil {
			return 0, false
		}
	} else if len(body) <= 2 {
		if hours, err = strconv.Atoi(body); err != nil {
			return 0, false
		}
	} else {
		return 0, false
	}
	return sign * (hours*60 + minutes), true
}

// ToISO renders an ISO-8601 string: "YYYY-MM-DDTHH:MM:SS[.sss][(+|-)HH:MM | Z]".
// Subseconds are included only when present (milliseconds precision, matching
// exiftool-vendored's typical output). The timezone suffix is included only
// when the source carried one.
func (d ExifDateTime) ToISO() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%04d-%02d-%02dT%02d:%02d:%02d",
		d.Year, d.Month, d.Day, d.Hour, d.Minute, d.Second)
	if d.HasSubsec {
		// Render milliseconds (3 digits), matching exiftool-vendored output.
		ms := d.Nanosecond / 1e6
		fmt.Fprintf(&b, ".%03d", ms)
	}
	if d.TzOffsetMinutes != nil {
		// Render a zero offset as "Z" (UTC), matching exiftool-vendored's ISO
		// output. Non-zero offsets use "+HH:MM"/"-HH:MM". Note capture_tz_offset
		// is rendered separately via TzOffsetString and stays "+00:00".
		if *d.TzOffsetMinutes == 0 {
			b.WriteString("Z")
		} else {
			b.WriteString(offsetSuffix(*d.TzOffsetMinutes))
		}
	}
	return b.String()
}

// ToSQLiteLocal renders "YYYY-MM-DD HH:MM:SS" (no subseconds, no timezone),
// matching values written by SQLite's datetime('now','localtime'). The wall
// clock components are used as-is (the offset is dropped, not applied).
func (d ExifDateTime) ToSQLiteLocal() string {
	return fmt.Sprintf("%04d-%02d-%02d %02d:%02d:%02d",
		d.Year, d.Month, d.Day, d.Hour, d.Minute, d.Second)
}

// TzOffsetString returns the timezone offset as "+HH:MM" / "-HH:MM" and true,
// or "" and false when the source had no timezone.
func (d ExifDateTime) TzOffsetString() (string, bool) {
	if d.TzOffsetMinutes == nil {
		return "", false
	}
	return offsetSuffix(*d.TzOffsetMinutes), true
}

// Unix returns the value as a Unix timestamp (seconds). When the source had no
// timezone, the components are interpreted in the machine's local time zone.
func (d ExifDateTime) Unix() int64 {
	loc := time.Local
	if d.TzOffsetMinutes != nil {
		loc = time.FixedZone("", *d.TzOffsetMinutes*60)
	}
	t := time.Date(d.Year, time.Month(d.Month), d.Day,
		d.Hour, d.Minute, d.Second, d.Nanosecond, loc)
	return t.Unix()
}

// AsUTC returns a copy whose wall-clock components are interpreted as UTC
// (offset 0), without shifting them. Use for naive video timestamps, which are
// stored in UTC by convention but reported without an offset.
func (d ExifDateTime) AsUTC() ExifDateTime {
	zero := 0
	d.TzOffsetMinutes = &zero
	return d
}

// In converts the instant represented by this value into the given location,
// recomputing the wall-clock components and offset. If the value has no
// timezone it is first interpreted in loc (no shift). Subseconds are preserved.
func (d ExifDateTime) In(loc *time.Location) ExifDateTime {
	var from *time.Location
	if d.TzOffsetMinutes != nil {
		from = time.FixedZone("", *d.TzOffsetMinutes*60)
	} else {
		from = loc
	}
	t := time.Date(d.Year, time.Month(d.Month), d.Day,
		d.Hour, d.Minute, d.Second, d.Nanosecond, from).In(loc)
	_, offSec := t.Zone()
	offMin := offSec / 60
	return ExifDateTime{
		Year: t.Year(), Month: int(t.Month()), Day: t.Day(),
		Hour: t.Hour(), Minute: t.Minute(), Second: t.Second(),
		Nanosecond: t.Nanosecond(), HasSubsec: d.HasSubsec,
		TzOffsetMinutes: &offMin,
	}
}

// DateString returns "YYYY-MM-DD".
func (d ExifDateTime) DateString() string {
	return fmt.Sprintf("%04d-%02d-%02d", d.Year, d.Month, d.Day)
}

// TimeString returns "HH:MM:SS".
func (d ExifDateTime) TimeString() string {
	return fmt.Sprintf("%02d:%02d:%02d", d.Hour, d.Minute, d.Second)
}

// offsetSuffix formats signed minutes as "+HH:MM" / "-HH:MM".
func offsetSuffix(offsetMinutes int) string {
	sign := "+"
	if offsetMinutes < 0 {
		sign = "-"
		offsetMinutes = -offsetMinutes
	}
	return fmt.Sprintf("%s%02d:%02d", sign, offsetMinutes/60, offsetMinutes%60)
}
