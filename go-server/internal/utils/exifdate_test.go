package utils

import (
	"testing"
	"time"
)

func TestParseExifDate_ISO(t *testing.T) {
	cases := []struct {
		in      string
		wantISO string
		wantSQL string
	}{
		// Composite SubSec: subseconds + tz -> ISO keeps both; SQLite drops tz/subsec.
		{"2025:09:11 18:02:17.774-04:00", "2025-09-11T18:02:17.774-04:00", "2025-09-11 18:02:17"},
		{"2026:05:30 21:32:01.173-07:00", "2026-05-30T21:32:01.173-07:00", "2026-05-30 21:32:01"},
		// Plain EXIF: no subsec, no tz.
		{"2025:09:11 18:02:17", "2025-09-11T18:02:17", "2025-09-11 18:02:17"},
		// FileModifyDate: tz, no subsec.
		{"2025:09:15 11:33:32-04:00", "2025-09-15T11:33:32-04:00", "2025-09-15 11:33:32"},
		// UTC 'Z'.
		{"2025:09:11 22:01:39Z", "2025-09-11T22:01:39Z", "2025-09-11 22:01:39"},
		// Already-ISO input (dash date, T separator).
		{"2024-07-27T10:30:00+05:30", "2024-07-27T10:30:00+05:30", "2024-07-27 10:30:00"},
		// Offset without colon.
		{"2024-07-27T10:30:00+0530", "2024-07-27T10:30:00+05:30", "2024-07-27 10:30:00"},
	}
	for _, c := range cases {
		d, ok := ParseExifDate(c.in)
		if !ok {
			t.Fatalf("ParseExifDate(%q) failed", c.in)
		}
		if got := d.ToISO(); got != c.wantISO {
			t.Errorf("ToISO(%q) = %q, want %q", c.in, got, c.wantISO)
		}
		if got := d.ToSQLiteLocal(); got != c.wantSQL {
			t.Errorf("ToSQLiteLocal(%q) = %q, want %q", c.in, got, c.wantSQL)
		}
	}
}

func TestParseExifDate_Invalid(t *testing.T) {
	for _, in := range []string{"", "0000:00:00 00:00:00", "garbage", "2025:09:11"} {
		if _, ok := ParseExifDate(in); ok {
			t.Errorf("ParseExifDate(%q) should have failed", in)
		}
	}
}

func TestExifDateTime_Components(t *testing.T) {
	d, ok := ParseExifDate("2025:09:14 13:33:31.186-04:00")
	if !ok {
		t.Fatal("parse failed")
	}
	if d.DateString() != "2025-09-14" {
		t.Errorf("DateString = %q", d.DateString())
	}
	if d.TimeString() != "13:33:31" {
		t.Errorf("TimeString = %q", d.TimeString())
	}
	off, ok := d.TzOffsetString()
	if !ok || off != "-04:00" {
		t.Errorf("TzOffsetString = %q, %v", off, ok)
	}
	if d.TzOffsetMinutes == nil || *d.TzOffsetMinutes != -240 {
		t.Errorf("TzOffsetMinutes = %v", d.TzOffsetMinutes)
	}
}

func TestExifDateTime_NoTzFloating(t *testing.T) {
	d, _ := ParseExifDate("2025:09:11 18:02:17")
	if d.TzOffsetMinutes != nil {
		t.Errorf("expected nil tz, got %v", d.TzOffsetMinutes)
	}
	if _, ok := d.TzOffsetString(); ok {
		t.Errorf("expected no tz string")
	}
}

func TestExifDateTime_AsUTC(t *testing.T) {
	// Naive video-style timestamp interpreted as UTC.
	d, _ := ParseExifDate("2026:09:03 12:14:04")
	u := d.AsUTC()
	if u.TzOffsetMinutes == nil || *u.TzOffsetMinutes != 0 {
		t.Fatalf("AsUTC offset = %v, want 0", u.TzOffsetMinutes)
	}
	if got := u.ToISO(); got != "2026-09-03T12:14:04Z" {
		t.Errorf("AsUTC ToISO = %q", got)
	}
	// capture_tz_offset is rendered separately and stays +00:00 (not Z).
	if off, ok := u.TzOffsetString(); !ok || off != "+00:00" {
		t.Errorf("AsUTC TzOffsetString = %q, %v; want +00:00", off, ok)
	}
}

func TestExifDateTime_InZone(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata not available")
	}
	// UTC 12:14:04 on 2026-09-03 -> EDT 08:14:04-04:00 (same calendar day).
	d, _ := ParseExifDate("2026:09:03 12:14:04")
	local := d.AsUTC().In(loc)
	if local.DateString() != "2026-09-03" {
		t.Errorf("local date = %q, want 2026-09-03", local.DateString())
	}
	if local.TimeString() != "08:14:04" {
		t.Errorf("local time = %q, want 08:14:04", local.TimeString())
	}
	if off, _ := local.TzOffsetString(); off != "-04:00" {
		t.Errorf("local offset = %q, want -04:00", off)
	}
	// Cross-midnight case: UTC 02:00 on the 3rd is 22:00 on the 2nd in EDT.
	d2, _ := ParseExifDate("2026:09:03 02:00:00")
	local2 := d2.AsUTC().In(loc)
	if local2.DateString() != "2026-09-02" {
		t.Errorf("cross-midnight local date = %q, want 2026-09-02", local2.DateString())
	}
}
