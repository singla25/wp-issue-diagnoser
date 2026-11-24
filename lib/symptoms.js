// Symptom ids that carry NO claim about the kind of problem. They are treated exactly like "other" wherever the code compares a symptom with a family, a
// known pattern or a setting: 'connection-not-private' says what the browser showed, not which part of the site is at fault, so it must never raise or lower a
// score or give a verdict a stronger footing than "other" would (4i-c). One list, used by every such comparison.
const OTHER_LIKE = new Set(['other', 'connection-not-private']);
const isOtherLike = symptom => OTHER_LIKE.has(symptom);
module.exports = { OTHER_LIKE, isOtherLike };
