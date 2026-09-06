const express = require('express');
const { isEnabled } = require('@librechat/api');
const staticCache = require('../utils/staticCache');
const paths = require('~/config/paths');

const skipGzipScan = !isEnabled(process.env.ENABLE_IMAGE_OUTPUT_GZIP_SCAN);
const DBM_PRIVATE_PERSIST_PREFIX = '.dbm-persist-';

function isDbmPrivatePersistPath(requestPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    // Fail closed for malformed encoded paths rather than handing them to the
    // static file middleware.
    return true;
  }

  return decodedPath
    .split('/')
    .filter(Boolean)
    .some((segment) => segment.startsWith(DBM_PRIVATE_PERSIST_PREFIX));
}

const router = express.Router();

// DBM Chat reuses the single Railway image volume for a hidden private
// persistence subtree used by /app/uploads and synchronized Skill files.
// Never make that subtree reachable through the public /images static route.
router.use((req, res, next) => {
  if (isDbmPrivatePersistPath(req.path)) {
    return res.sendStatus(404);
  }
  return next();
});

router.use(staticCache(paths.imageOutput, { skipGzipScan }));

module.exports = router;
