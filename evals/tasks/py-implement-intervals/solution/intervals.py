"""Working with closed intervals of whole numbers."""


def merge_intervals(intervals):
    """Merge overlapping intervals.

    `intervals` is an iterable of (start, end) pairs (tuples or lists) of integers with start <= end,
    in any order. Both ends are included, so (1, 3) and (3, 5) overlap at 3 and become (1, 5). Intervals
    that merely sit next to each other, like (1, 2) and (3, 4), do not overlap and stay apart.

    Returns a new list of (start, end) tuples sorted by start, with no two of them overlapping.
    The input is not modified. An empty input gives an empty list.

    Raises ValueError if any interval has start > end.
    """
    pairs = [(start, end) for start, end in intervals]
    for start, end in pairs:
        if start > end:
            raise ValueError(f"interval ({start}, {end}) ends before it starts")
    merged = []
    for start, end in sorted(pairs):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged
