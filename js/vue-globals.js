// Loaded first. Classic scripts share one global scope, so Vue's helpers are
// destructured once here and used by every file that follows.
const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;
