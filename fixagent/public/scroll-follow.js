const distanceFromBottom = ({ scrollHeight, scrollTop, clientHeight }) =>
  Math.max(0, scrollHeight - scrollTop - clientHeight);

export function createScrollFollowState({
  followThreshold = 96,
  resumeThreshold = 8,
} = {}) {
  let following = true;
  let lastScrollTop = 0;

  return {
    isFollowing() {
      return following;
    },
    observe(metrics) {
      const movingUp = metrics.scrollTop < lastScrollTop - 1;
      const distance = distanceFromBottom(metrics);

      if (movingUp || (following && distance > followThreshold)) {
        following = false;
      } else if (!following && !movingUp && distance <= resumeThreshold) {
        following = true;
      }

      lastScrollTop = metrics.scrollTop;
      return following;
    },
    pause() {
      following = false;
    },
    resume(metrics) {
      following = true;
      if (metrics) lastScrollTop = metrics.scrollTop;
    },
  };
}
