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

export { filenameToName, resetAnimation };