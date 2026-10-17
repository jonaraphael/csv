import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { it } from 'node:test';
const { JSDOM } = require('jsdom');

it('updates dark/light chrome after leaving either high-contrast variant without replacing an active multiline draft', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'media', 'high-contrast.css'), 'utf8');
  for (const [initial, ordinary] of [['vscode-high-contrast', 'vscode-light'], ['vscode-high-contrast-light', 'vscode-dark']]) {
    const dom = new JSDOM(`<style>${css}</style><body class="${initial}"><table><thead><tr><th style="background-color:${initial.endsWith('light') ? '#fff' : '#1e1e1e'}">Header</th></tr></thead><tbody><tr><td contenteditable="true" tabindex="0">line one\nline two</td></tr></tbody></table><div id="contextMenu"></div><div id="findReplaceWidget"><input class="fr-input"></div></body>`);
    const { document } = dom.window;
    const cell = document.querySelector('td');
    cell.focus();
    const range = document.createRange();
    range.setStart(cell.firstChild, 5);
    range.collapse(true);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(range);
    document.body.className = ordinary;
    const rules = Array.from(document.styleSheets[0].cssRules) as any[];
    const declarationsFor = (element: any, property: string) => rules.filter(rule => element.matches(rule.selectorText)).map(rule => rule.style.getPropertyValue(property)).filter(Boolean);
    for (const [element, token] of [[document.body, '--vscode-editor-background'], [document.querySelector('th'), '--vscode-editor-background'], [document.querySelector('#contextMenu'), '--vscode-menu-background'], [document.querySelector('.fr-input'), '--vscode-input-background']] as any[]) {
      assert.ok(declarationsFor(element, 'background-color').some(value => value.includes(token)), `${ordinary} ${element.tagName} background follows live theme`);
    }
    assert.strictEqual(document.querySelector('td'), cell);
    assert.strictEqual(cell.textContent, 'line one\nline two');
    assert.strictEqual(document.activeElement, cell);
    assert.strictEqual(dom.window.getSelection().anchorNode, cell.firstChild);
    assert.strictEqual(dom.window.getSelection().anchorOffset, 5);
    assert.ok(!declarationsFor(cell, 'color').some(value => value.includes('--vscode-editor-foreground')), 'ordinary cells retain their type palette');
    dom.window.close();
  }
});
