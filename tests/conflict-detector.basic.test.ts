/**
 * Basic smoke tests for ConflictDetector
 */

import { describe, it, expect } from 'vitest';
import { ConflictDetector, type ConflictMarkers } from '../src/conflict-detector.js';

describe('ConflictDetector', () => {
  describe('parseConflictMarkers', () => {
    it('should parse basic conflict markers', () => {
      const detector = new ConflictDetector('/tmp/test');

      const content = `
<<<<<<< HEAD
function foo() { return 'ours'; }
=======
function foo() { return 'theirs'; }
>>>>>>> feature
`;

      // Access private method via type assertion for testing
      const markers = (detector as any).parseConflictMarkers(content);

      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        oursContent: expect.stringContaining('ours'),
        theirsContent: expect.stringContaining('theirs')
      });
    });

    it('should handle multiple conflict markers', () => {
      const detector = new ConflictDetector('/tmp/test');

      const content = `
<<<<<<< HEAD
line 1 ours
=======
line 1 theirs
>>>>>>> feature

some normal content

<<<<<<< HEAD
line 2 ours
=======
line 2 theirs
>>>>>>> feature
`;

      const markers = (detector as any).parseConflictMarkers(content);

      expect(markers).toHaveLength(2);
    });
  });

  describe('classifyConflict', () => {
    it('should classify trivial conflicts', () => {
      const detector = new ConflictDetector('/tmp/test');

      const markers: ConflictMarkers = {
        start: 0,
        divider: 2,
        end: 4,
        oursContent: 'function foo() {}',
        theirsContent: 'function foo() {}'
      };

      const type = detector.classifyConflict({
        filePath: 'test.ts',
        markers
      });

      expect(type).toBe('TRIVIAL');
    });

    it('should classify concurrent edits', () => {
      const detector = new ConflictDetector('/tmp/test');

      const markers: ConflictMarkers = {
        start: 0,
        divider: 2,
        end: 4,
        oursContent: 'const x = 1;',
        theirsContent: 'const x = 2;'
      };

      const type = detector.classifyConflict({
        filePath: 'test.ts',
        markers
      });

      expect(type).toBe('CONCURRENT_EDIT');
    });
  });

  describe('calculateSeverity', () => {
    it('should return LOW for trivial conflicts', () => {
      const detector = new ConflictDetector('/tmp/test');

      const conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL' as const,
        severity: 'LOW' as const,
        markers: []
      };

      const severity = detector.calculateSeverity(conflict);

      expect(severity).toBe('LOW');
    });

    it('should return HIGH for multiple semantic conflicts', () => {
      const detector = new ConflictDetector('/tmp/test');

      const conflict = {
        filePath: 'test.ts',
        conflictType: 'SEMANTIC' as const,
        severity: 'MEDIUM' as const,
        markers: [{}, {}, {}] as any[] // 3 markers
      };

      const severity = detector.calculateSeverity(conflict);

      expect(severity).toBe('HIGH');
    });
  });

  describe('normalizeWhitespace', () => {
    it('should normalize whitespace correctly', () => {
      const detector = new ConflictDetector('/tmp/test');

      const input = `
        function   foo()   {
          return    'test';
        }
      `;

      const normalized = (detector as any).normalizeWhitespace(input);

      expect(normalized).toContain('function foo()');
      expect(normalized).not.toContain('   '); // No triple spaces
    });
  });

  describe('escapeShellArg', () => {
    it('should escape single quotes', () => {
      const detector = new ConflictDetector('/tmp/test');

      const escaped = (detector as any).escapeShellArg("feature/user's-branch");

      expect(escaped).toContain("'\\''");
    });
  });
});
