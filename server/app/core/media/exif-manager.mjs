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
    objects: tags.RegionInfo ? tags.RegionInfo.RegionList.filter(d=>d.Type!='Face').map(d=>d.Name) : null,
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
    gps_long: tags.GPSLongitude||null,
    gps_alt: tags.GPSAltitude||null,
    gpsposition: tags.GPSPosition||null,
    geolocation_api_json: {
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
    geo_address: [
      tags.GeolocationCity || null,
      tags.GeolocationSubregion || null,
      tags.GeolocationRegion || null,
      tags.GeolocationCountryCode || null,
      tags.GeolocationCountry || null
    ].filter(x=>x).join(", ") || null,
    duration: tags.Duration||null,
    datetime_original: validExifDate(tags.DateTimeOriginal),
    create_date: validExifDate(tags.CreateDate),
    file_modify_date: tags.FileModifyDate ? tags.FileModifyDate.toString() : null,
    // capture_time is the capture time (or best fallback). file-indexer fills the
    // gap from folder path (in-place) or mtime (intake) when both EXIF
    // dates are invalid/missing.
    capture_time: validExifDate(tags.DateTimeOriginal) || validExifDate(tags.CreateDate) || null
  }

}

export async function updateMetadata(file, updates){
  // TODO: provide -overwrite_original as an option
  // Design a slower but safer write mechanism where the original is compared with the modified
  // (both image and metadata) and the only diffs should be the updates

  await exiftool.write(file, updates, ['-overwrite_original']);
}

