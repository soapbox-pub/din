/**
 * Keeps the engine that embeds guests (Electron's <webview> today) inside
 * src/platform/, so it can be swapped (docs/guest-surfaces.md). Elsewhere,
 * embed a guest with <GuestSurface> and find one with src/platform/guest.ts.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid <webview> and its methods outside src/platform/',
    },
    schema: [],
    messages: {
      element: 'Embed guests with <GuestSurface> from @/platform/GuestSurface, not <webview>.',
      tag: "The 'webview' element belongs to src/platform/; use its guest helpers.",
      method: '{{name}} is the engine\'s; use the helpers in @/platform/guest.',
    },
  },

  create(context) {
    const ENGINE_METHODS = new Set(['getWebContentsId']);
    return {
      JSXOpeningElement(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === 'webview') {
          context.report({ node, messageId: 'element' });
        }
      },
      Literal(node) {
        if (typeof node.value === 'string' && /^webview$/i.test(node.value)) {
          context.report({ node, messageId: 'tag' });
        }
      },
      MemberExpression(node) {
        if (!node.computed && node.property.type === 'Identifier' && ENGINE_METHODS.has(node.property.name)) {
          context.report({ node, messageId: 'method', data: { name: node.property.name } });
        }
      },
    };
  },
};
