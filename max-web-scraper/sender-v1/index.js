'use strict'

module.exports = {
  ...require('./authentication'),
  ...require('./canaryPolicy'),
  ...require('./FencedTextSenderBoundary'),
  ...require('./SyntheticTextSenderAdapter'),
}
