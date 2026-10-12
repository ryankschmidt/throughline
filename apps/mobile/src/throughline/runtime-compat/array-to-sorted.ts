// Both native Hermes apps lack toSorted. Only this standard Array method is polyfilled;
// core-js preserves a conforming native implementation and does not replace at.
import "core-js/modules/es.array.to-sorted.js";
