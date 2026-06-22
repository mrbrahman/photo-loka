import {ExifTool} from 'exiftool-vendored';

const exiftool = new ExifTool({
  numericTags: ['FileSize', 'Orientation', 'Duration', 'GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'Rating', 'ImageWidth', 'ImageHeight'],
  geolocation: true
});

// Treat missing, year-zero, or unparseable EXIF dates as null. exiftool-vendored
// usually returns ExifDateTime instances with year/month/day, but for malformed
// values it may yield strings like '0000:00:00 00:00:00' or year < 1900.
function validExifDate(tag) {
  if (!tag) return null;

  // ExifDateTime instances expose .year. Trust their parser.
  if (typeof tag === 'object' && typeof tag.year === 'number') {
    if (tag.year < 1900) return null;
    return tag.toString();
  }

  // Fallback: string-like value. Reject obvious garbage and unparseable strings.
  const s = tag.toString();
  if (!s || s.startsWith('0000')) return null;
  const d = new Date(s);
  if (isNaN(d.getTime()) || d.getFullYear() < 1900) return null;
  return s;
}

// Extract a structured captureDateTime object from an ExifDateTime tag.
// Returns null if the tag is not a valid ExifDateTime.
// This is the canonical representation passed through the indexing pipeline --
// decoupled from the exiftool-vendored ExifDateTime class so downstream code
// has no library dependency.
function extractCaptureDateTime(tag) {
  if (!tag || typeof tag !== 'object' || typeof tag.year !== 'number') return null;
  if (tag.year < 1900) return null;

  return {
    year: tag.year,
    month: tag.month,
    day: tag.day,
    hour: tag.hour,
    minute: tag.minute,
    second: tag.second,
    tzOffsetMinutes: tag.tzoffsetMinutes ?? null
  };
}

// Extract the IANA timezone name from an ExifDateTime object.
// Returns null if the tag is not an ExifDateTime or zone is unknown/unset.
// Note: ExifDateTime.zone requires @photostructure/tz-lookup to resolve GPS
// to IANA names. Without it, .zone returns generic offset names like 'UTC-4'.
// We fall back to it but prefer GeolocationTimeZone passed separately.
function extractZoneName(tag) {
  if (!tag || typeof tag !== 'object') return null;
  const zone = tag.zone;
  if (!zone || zone === 'UnsetZone') return null;
  // Reject generic offset-based names (e.g. 'UTC-4', 'UTC+5:30') - these
  // aren't real IANA names and don't help with abbreviation lookups.
  if (/^UTC[+-]/.test(zone)) return null;
  return zone;
}

export async function getMetadata(file){
  // exiftool needs a file, and not buffer
  // since it is just a wrapper around perl exiftool
  // https://github.com/photostructure/exiftool-vendored.js/issues/2
  let tags = await exiftool.read(file);

  let fileType = (tags["MIMEType"]||"x").split("/")[0],
    w=tags.ImageWidth||0, h=tags.ImageHeight||0,
    aspectRatio=0;

  // we'll be rotating the thumbnails where appliable
  // so calculate the aspect ratio considering the rotated image
  if (w && h && ["image","video"].indexOf(fileType)>=0){
    switch(fileType){
      case "image":
        aspectRatio = tags.Orientation ? 
          ([6,8].indexOf(tags.Orientation) >=0) ? h/w : w/h
          : w/h;
        break;

      case "video":
        aspectRatio = tags.Rotation ? 
          ([90,270].indexOf(tags.Rotation) >=0) ? h/w : w/h
          : w/h;
        break;
    }
  }

  // console.log(tags);

  return {
    description: tags.ImageDescription ? tags.ImageDescription.trim() : null,
    filesize: tags.FileSize||null,
    ext: tags.FileName.split(".").pop().toLowerCase(),
    mimetype: tags.MIMEType||null,
    mediatype: fileType,
    keywords: tags.Keywords ? ((typeof(tags.Keywords) == "string") ?  [tags.Keywords] : tags.Keywords) : null,
    xmpregion: tags.RegionInfo,
    faces: tags.RegionInfo ? tags.RegionInfo.RegionList.filter(d=>d.Type='Face').map(d=>d.Name) : null,
    rating: tags.Rating||0,
    image_width: tags.ImageWidth||null,
    image_height: tags.ImageHeight||null,
    software: tags.Software||null,       // TODO: new column in db metadata table
    aspectratio: aspectRatio,
    make: tags.Make||null,
    model: tags.Model||null,
    orientation: 
      fileType=='image' && typeof(tags.Orientation!=='undefined') ? // Orientation can be "0"
        tags.Orientation : 
        fileType=='video' && typeof(tags.Rotation!=='undefined') ? tags.Rotation : null, 
    gps_lat: tags.GPSLatitude||null,
    gps_lng: tags.GPSLongitude||null,
    gps_alt: tags.GPSAltitude||null,
    gpsposition: tags.GPSPosition||null,
    exiftool_geo_json: {
      GeolocationCity: tags.GeolocationCity || null,
      GeolocationRegion: tags.GeolocationRegion || null,
      GeolocationSubregion: tags.GeolocationSubregion || null,
      GeolocationCountryCode: tags.GeolocationCountryCode || null,
      GeolocationCountry: tags.GeolocationCountry || null,
      GeolocationTimeZone: tags.GeolocationTimeZone || null,
      GeolocationFeatureCode: tags.GeolocationFeatureCode || null,
      GeolocationFeatureType: tags.GeolocationFeatureType || null,
      GeolocationPopulation: tags.GeolocationPopulation || null,
      GeolocationPosition: tags.GeolocationPosition || null,
      GeolocationDistance: tags.GeolocationDistance || null,
      GeolocationBearin: tags.GeolocationBearing || null
    },
    duration: tags.Duration||null,
    datetime_original: validExifDate(tags.DateTimeOriginal),
    create_date: validExifDate(tags.CreateDate),
    file_modified_at: tags.FileModifyDate ? tags.FileModifyDate.toString() : null,
    // captured_at is the capture time (or best fallback). file-indexer fills the
    // gap from folder path (in-place) or mtime (intake) when both EXIF
    // dates are invalid/missing.
    captured_at: validExifDate(tags.DateTimeOriginal) || validExifDate(tags.CreateDate) || null,
    // Structured capture date/time extracted directly from ExifDateTime object
    // properties. Passed through the indexing pipeline for folder placement and
    // populating capture_date/time/offset columns. null when no EXIF date.
    captureDateTime: extractCaptureDateTime(tags.DateTimeOriginal) || extractCaptureDateTime(tags.CreateDate) || null,
    // IANA timezone name inferred by exiftool-vendored (from GPS, explicit
    // EXIF tags, or UTC delta). 'UnsetZone' means unknown.
    // Prefer GeolocationTimeZone (from exiftool's built-in geolocation DB,
    // always an IANA name when GPS is available) over ExifDateTime.zone
    // (which requires @photostructure/tz-lookup to be a real IANA name).
    capture_tz_name: tags.GeolocationTimeZone || extractZoneName(tags.DateTimeOriginal) || extractZoneName(tags.CreateDate) || null,
    exif_datetime_original_ref: validExifDate(tags.DateTimeOriginal),
    exif_create_date_ref: validExifDate(tags.CreateDate)
  }

}

export async function updateMetadata(file, updates){
  // TODO: provide -overwrite_original as an option
  // Design a slower but safer write mechanism where the original is compared with the modified
  // (both image and metadata) and the only diffs should be the updates

  await exiftool.write(file, updates, ['-overwrite_original']);
}

