const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.contentDir);
  },
  filename: (req, file, cb) => {
    // busboy decodes the Content-Disposition filename header as latin1 by
    // default. Modern clients send raw UTF-8 bytes for non-ASCII filenames
    // (e.g. browsers + curl on UTF-8 locales send "Begrussungsscreens.jpg"
    // with c3 bc for u-umlaut). Reading those bytes as latin1 produces the
    // string "A-tilde + quarter-mark" which JS then re-encodes as 4 UTF-8
    // bytes on the way to the DB - classic double-encoding mojibake.
    //
    // The `defParamCharset: 'utf8'` option below only takes effect for
    // RFC 5987 encoded `filename*=...` params, which most clients don't send.
    // For the plain `filename="..."` case, re-decode here to recover the
    // original UTF-8 byte sequence. Mutating originalname here propagates to
    // every downstream consumer (route handlers reading req.file.originalname).
    if (file.originalname) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    }
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'video/mp4', 'video/webm', 'video/avi', 'video/mkv', 'video/mov',
    'video/x-msvideo', 'video/quicktime', 'video/x-matroska',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'
  ];
  if (allowedTypes.includes(file.mimetype) || file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only video and image files are allowed'), false);
  }
};

// `defParamCharset: 'utf8'` makes busboy decode multipart filename headers as UTF-8.
// Default is latin1, which mangles umlauts and other non-ASCII characters
// (e.g. "Größe.jpg" arrives as "GrÃ¶ÃŸe.jpg" and gets stored that way).
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxFileSize },
  defParamCharset: 'utf8'
});

module.exports = upload;
