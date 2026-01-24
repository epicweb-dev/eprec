# E2E Test Recording Script

Record this as a single video with OBS chapters. Keep each chapter **under 5 seconds** of speech. Speak naturally but efficiently—this is for automated testing, not a demo.

Run with: `--min-chapter-seconds 2`

---

## Chapter 1: Normal Processing

> Hello this is a normal chapter that should be processed without any commands.

---

## Chapter 2: Bad Take

> This chapter has a mistake. Jarvis bad take thanks.

---

## Chapter 3: Filename Override

> Jarvis filename custom output name thanks. This chapter tests the filename command.

---

## Chapter 4: Edit Flag

> Jarvis edit thanks. This chapter will be flagged for manual editing.

---

## Chapter 5: Note Command

> Jarvis note remember to add graphics here thanks. This tests the note feature.

---

## Chapter 6: Nevermind Cancellation

> Let me say something. Jarvis nevermind thanks. That command should be removed but this speech kept.

---

## Chapter 7: Split Base

> This is part one of a split test.

---

## Chapter 8: Combine Previous

> Jarvis combine previous thanks. This content joins with chapter seven.

---

## Chapter 9: Too Short

> Hi.

_(This chapter should be skipped for being under the minimum duration threshold)_

---

## Chapter 10: New Chapter Alias

> Jarvis new chapter thanks. Testing the split alias command.

---

## Notes

- Wake word: `jarvis`
- Close word: `thanks`
- All commands must be spoken clearly
- Chapters are created in OBS via hotkey during recording
