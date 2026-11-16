// Tiny DOM helper for building UI panels without a framework.

let pressBinder = null;

/** Tell el() how to make an element a control. main.js passes input.press. */
export function setPressBinder(fn) {
  pressBinder = fn;
}

/**
 * el('button', { class: 'btn', press: fn }, 'Label', childNode, ...)
 * `press: fn` makes the element a control that runs fn when tapped, clicked or
 * activated with Enter. It goes through the input module, never a click listener
 * (brief §4: no other code reads raw mouse or touch events). Null children are skipped.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'press') {
      if (!pressBinder) throw new Error('el(): press used before setPressBinder()');
      pressBinder(node, value);
    }
    else if (key === 'class') node.className = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
