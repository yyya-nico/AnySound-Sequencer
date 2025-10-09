const filenameToName = (filename: string) => {
  return filename.split(".").slice(0, -1).join(".");
}

const resetAnimation = (elem: HTMLElement, token: string) => {
    elem.classList.remove(token);
    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
            elem.classList.add(token);
        });
    });
};

const dispatchPointerPressEvent = (elem: HTMLElement) => {
  let timeoutId: number;
  let startX: number;
  let startY: number;

  const onPointerDown = (e: PointerEvent) => {
    const targetCached = e.target as HTMLElement;
    startX = e.clientX;
    startY = e.clientY;

    timeoutId = window.setTimeout(() => {
      elem.dispatchEvent(new CustomEvent("pointerpress", {
        detail: {
          originalEvent: e,
          originalTarget: targetCached
        }
      }));
    }, 500);
  };

  const onPointerMove = (e: PointerEvent) => {
    const moveX = Math.abs(e.clientX - startX);
    const moveY = Math.abs(e.clientY - startY);
    if (moveX > 5 || moveY > 5) { // Threshold for movement
      clearTimeout(timeoutId);
    }
  };

  const onPointerUp = () => {
    clearTimeout(timeoutId);
  };

  elem.addEventListener("pointerdown", onPointerDown);
  elem.addEventListener("pointermove", onPointerMove);
  elem.addEventListener("pointerup", onPointerUp);
  elem.addEventListener("pointercancel", onPointerUp);
};

export { filenameToName, resetAnimation, dispatchPointerPressEvent };