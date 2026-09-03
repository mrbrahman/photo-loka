package utils

import "testing"

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
		{"2025:09:11 22:01:39Z", "2025-09-11T22:01:39+00:00", "2025-09-11 22:01:39"},
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
