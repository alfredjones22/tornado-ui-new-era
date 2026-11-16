import { createRenderer } from 'vue'

// Render the real SFC with Vue's renderer and minimal host nodes; no browser or RPC is needed.
export class Element {
  children: Element[] = []
  parent: Element | null = null
  props: Record<string, unknown> = {}
  events = new Map<string, (event: { target: Element }) => void>()
  value = ''
  checked = false
  focused = false
  style = { display: '' }
  get options() { return this.children.filter(child => child.tag === 'option') }
  constructor(public tag: string, public text = '') {}
  addEventListener(event: string, handler: (event: { target: Element }) => void) { this.events.set(event, handler) }
  getRootNode() { return this }
  focus() { this.focused = true }
}
export const renderer = createRenderer<Element, Element>({
  createElement: tag => new Element(tag), createText: text => new Element('text', text), createComment: () => new Element('comment'),
  insertStaticContent: (html, parent, anchor) => {
    // Static HTML has no reactive bindings; retain it as one opaque host node.
    const node = new Element('static', html), index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node); node.parent = parent
    return [node, node]
  },
  insert: (node, parent, anchor) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node); node.parent = parent
  },
  remove: node => { node.parent?.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text; node.children = [] },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp: (node, key, _previous, value) => { node.props[key] = value; if (key === 'value') node.value = value },
})
export const content = (node: Element): string => node.text + node.children.map(content).join('')
export const descendants = (node: Element): Element[] => [node, ...node.children.flatMap(descendants)]
export const button = (node: Element, label: string) => descendants(node).find(child => child.tag === 'button' && content(child).includes(label))
