const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.contentDir);
  },
  filename: (req, file, cb) => {
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
