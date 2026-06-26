// Respect prefers-reduced-motion for the demo video: don't autoplay, show the
// poster, and let a click/tap play it on demand.
(() => {
  const reduce =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll(".demo-video").forEach((video) => {
    if (reduce) {
      video.removeAttribute("autoplay");
      video.removeAttribute("loop");
      video.pause();
      video.addEventListener("click", () => {
        video.paused ? video.play() : video.pause();
      });
      video.style.cursor = "pointer";
    }
  });
})();

// Copy button handler — no external dependencies
document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.getAttribute("data-target");
    const pre = document.getElementById(target);
    if (!pre) return;
    const text = pre.innerText;
    const done = () => {
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 2000);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(text)
        .then(done)
        .catch(() => {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          document.body.removeChild(textarea);
          done();
        });
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    done();
  });
});
