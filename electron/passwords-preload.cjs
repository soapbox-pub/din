// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - that gives them Passwords' autofill (see
// electron/passwords.mts).
//
// It finds login fields, and when the user puts the cursor in one, tells
// main where the field is, so the desktop can show the vault's logins for
// the site below it; the login picked comes back here to be typed in. A
// login the user types and submits is reported too, for the desktop to
// offer to save. Nothing of the vault is ever handed to the page except the
// login the user picks.
//
// Stays in the isolated world: the page can't see or call any of this. It
// can see the events filling dispatches, which is what makes its own
// scripts notice the values, and the values themselves, as it would had
// they been typed.
//
// Registered with session.registerPreloadScript in main.mts, so it runs in
// every frame of web pages, each on its own.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { ipcRenderer } = require('electron');

if (/^https?:$/.test(location.protocol)) {
  /** The login field the cursor is in, or was last. */
  /** @type {HTMLInputElement | null} */
  let current = null;
  /** Whether the desktop is showing suggestions for `current`, and one is highlighted. */
  let shown = false;
  let highlighted = false;
  /** Filling: the focus and input events it causes aren't the user's. */
  let filling = false;
  /** Password fields the user typed in, or that got a generated password. */
  /** @type {WeakSet<HTMLInputElement>} */
  const typed = new WeakSet();
  /** @type {WeakSet<HTMLInputElement>} */
  const generated = new WeakSet();
  /** The username typed on an earlier step (sites that ask for it on a page of its own). */
  let earlierUsername = '';
  let lastSubmitted = { password: '', at: 0 };

  /** @param {Element | null} el */
  const visible = (el) => !!el && el.getClientRects().length > 0;

  /** @param {EventTarget | null} el @returns {el is HTMLInputElement} */
  const isInput = (el) => el instanceof HTMLInputElement;

  /** @param {HTMLInputElement} input */
  const hints = (input) => `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label') ?? ''}`;

  /** @param {HTMLInputElement} input */
  const scopeOf = (input) => input.form ?? document;

  /** @param {Document | HTMLFormElement} scope */
  const passwordFields = (scope) =>
    /** @type {HTMLInputElement[]} */ ([...scope.querySelectorAll('input[type=password]')]).filter(
      (i) => !i.disabled && visible(i),
    );

  /** @param {HTMLInputElement} input */
  const isNewPassword = (input) => {
    const autocomplete = (input.getAttribute('autocomplete') ?? '').toLowerCase();
    if (autocomplete.includes('current-password')) return false;
    if (autocomplete.includes('new-password')) return true;
    if (/new|confirm|repeat|signup|sign-up|register|create/i.test(hints(input))) return true;
    return input.form ? passwordFields(input.form).length >= 2 : false;
  };

  /**
   * What kind of login field this is, if it is one.
   * @param {EventTarget | null} el
   * @returns {'username' | 'password' | 'new-password' | null}
   */
  const loginKind = (el) => {
    if (!isInput(el) || el.disabled || el.readOnly) return null;
    if (el.type === 'password') return isNewPassword(el) ? 'new-password' : 'password';
    if (el.type !== 'text' && el.type !== 'email' && el.type !== 'tel') return null;
    const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    if (/\b(username|webauthn)\b/.test(autocomplete)) return 'username';
    if (passwordFields(scopeOf(el)).length === 0) return null;
    if (/\bemail\b/.test(autocomplete) || el.type === 'email') return 'username';
    return /user|e-?mail|login|account|identifier|phone/i.test(hints(el)) ? 'username' : null;
  };

  /**
   * The field a username goes in, for a password field (the last text field before it).
   * @param {HTMLInputElement} password
   */
  const usernameFor = (password) => {
    const fields = /** @type {HTMLInputElement[]} */ ([...scopeOf(password).querySelectorAll('input')]);
    let best = null;
    for (const field of fields) {
      if (field === password) break;
      if (!field.disabled && visible(field) && (loginKind(field) === 'username' || field.type === 'email' || field.type === 'text')) {
        best = field;
      }
    }
    return best;
  };

  /** @param {HTMLInputElement} input */
  const report = (input) => {
    const kind = loginKind(input);
    if (!kind) return;
    current = input;
    const r = input.getBoundingClientRect();
    ipcRenderer.send('passwords:field', {
      kind,
      rect: {
        x: r.left / innerWidth,
        y: r.top / innerHeight,
        width: r.width / innerWidth,
        height: r.height / innerHeight,
      },
    });
  };

  const hide = () => {
    if (!shown) return;
    shown = false;
    ipcRenderer.send('passwords:blur');
  };

  /**
   * Type a value in the way the page's own scripts notice.
   * @param {HTMLInputElement} input @param {string} value
   */
  const type = (input, value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /** A login form's field to fill, when the cursor isn't in one (the browser's toolbar). */
  const firstLoginField = () => {
    const password = passwordFields(document)[0];
    if (password) return password;
    return /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input')]).find(
      (i) => visible(i) && loginKind(i) === 'username',
    ) ?? null;
  };

  /** Report a login being submitted, if the user typed (or generated) its password. */
  /** @param {Document | HTMLFormElement} scope */
  const submitted = (scope) => {
    const fields = passwordFields(scope).filter((i) => i.value && (typed.has(i) || generated.has(i)));
    if (fields.length === 0) return;
    // A form with a new password (signing up, changing it) saves the new one.
    const password = fields.find(isNewPassword) ?? fields[0];
    const usernameField = usernameFor(fields[0]);
    const username = usernameField?.value.trim() || earlierUsername;
    if (password.value === lastSubmitted.password && Date.now() - lastSubmitted.at < 3000) return;
    lastSubmitted = { password: password.value, at: Date.now() };
    ipcRenderer.send('passwords:submitted', { username, password: password.value });
  };

  /** Whether the field lost the keyboard with the whole page, not to another field in it. */
  let pageBlurred = false;

  document.addEventListener('focusin', (event) => {
    if (!event.isTrusted || filling) return;
    // The page getting the keyboard back (after a click on the suggestions) isn't the user going into the field.
    if (pageBlurred && event.target === current) {
      pageBlurred = false;
      return;
    }
    pageBlurred = false;
    if (loginKind(event.target)) report(/** @type {HTMLInputElement} */ (event.target));
  }, true);

  // A click on the desktop's suggestions takes the keyboard from the page
  // before the click lands, so a field left focused in a page that lost focus
  // only says so, and main decides whether the suggestions stay.
  document.addEventListener('focusout', (event) => {
    if (event.target !== current) return;
    const field = current;
    setTimeout(() => {
      if (document.activeElement === field && !document.hasFocus()) {
        pageBlurred = true;
        if (shown) ipcRenderer.send('passwords:page-blur');
      } else if (field === current) {
        hide();
      }
    });
  }, true);

  // A click in the field it's already in brings the suggestions back.
  document.addEventListener('pointerdown', (event) => {
    if (event.isTrusted && current && event.target === current && document.activeElement === current && !shown) report(current);
  }, true);

  document.addEventListener('input', (event) => {
    if (!event.isTrusted || filling || !isInput(event.target)) return;
    const input = event.target;
    if (input.type === 'password') typed.add(input);
    else if (loginKind(input) === 'username') earlierUsername = input.value.trim();
    if (input === current) hide();
  }, true);

  addEventListener('scroll', hide, { capture: true, passive: true });
  addEventListener('resize', hide, { passive: true });

  addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.target !== current || !current) return;
    const key = event.key;
    if (shown && (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Escape' || (key === 'Enter' && highlighted))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ipcRenderer.send('passwords:key', key);
      if (key === 'Escape') shown = false;
      return;
    }
    if (!shown && key === 'ArrowDown') report(current);
    if (key === 'Enter') submitted(scopeOf(current));
  }, true);

  document.addEventListener('submit', (event) => {
    if (event.target instanceof HTMLFormElement) submitted(event.target);
  }, true);

  // Plenty of sites log in from a script on a button's click, not a submit.
  // Only buttons that say so: not the eye that shows the password.
  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const button = event.target.closest('button, input[type=submit], input[type=button], [role=button]');
    if (!button) return;
    const label = `${button.textContent ?? ''} ${button.getAttribute('value') ?? ''} ${button.getAttribute('aria-label') ?? ''}`;
    if (button.getAttribute('type') !== 'submit' && !/log\s?in|sign\s?(in|up)|continue|next|submit|register|create|save|enter/i.test(label)) return;
    submitted(button.closest('form') ?? document);
  }, true);

  ipcRenderer.on('passwords:shown', (_event, /** @type {{ visible: boolean, highlighted: boolean }} */ state) => {
    shown = state.visible;
    highlighted = state.highlighted;
  });

  ipcRenderer.on('passwords:fill', (_event, /** @type {{ username: string | null, password: string, generated: boolean }} */ login) => {
    const anchor = current?.isConnected ? current : firstLoginField();
    if (!anchor) return;
    filling = true;
    try {
      if (login.generated) {
        for (const field of passwordFields(scopeOf(anchor)).filter(isNewPassword)) {
          type(field, login.password);
          generated.add(field);
        }
        return;
      }
      const anchorKind = loginKind(anchor);
      const password = anchorKind === 'password' || anchorKind === 'new-password'
        ? anchor
        : passwordFields(scopeOf(anchor)).find((f) => !isNewPassword(f)) ?? null;
      const username = anchorKind === 'username' ? anchor : password ? usernameFor(password) : null;
      if (login.username && username) type(username, login.username);
      if (password) type(password, login.password);
    } finally {
      filling = false;
    }
  });
}
