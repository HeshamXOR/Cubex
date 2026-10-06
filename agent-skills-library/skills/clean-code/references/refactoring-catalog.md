# Refactoring catalog

Each entry: smell, why it hurts, the move, and a compact example. Apply one at a time, with tests green between steps.

## Contents
1. Long function
2. Deep nesting
3. Long parameter list and data clumps
4. Boolean flag parameters
5. Primitive obsession
6. Repeated conditionals on type
7. Feature envy and Demeter violations
8. Magic numbers and strings
9. Duplicated logic
10. God class or module
11. Shotgun surgery and divergent change
12. Mutable shared state and temporal coupling
13. Dead code and speculative generality
14. Error-handling smells
15. Comment smells
16. Mechanics checklist

## 1. Long function
Hurts: hides intent, hard to test, hard to reuse.
Move: **Extract Function** for each cohesive block; name it after *what*, not *how*. Replace temporaries with queries; split phases (parse, validate, compute, persist).
```python
# before
def process_order(order):
    total = 0
    for item in order.items:
        total += item.price * item.qty
    if order.customer.tier == "gold":
        total *= 0.9
    total += total * 0.2
    db.save(order, total)
    mailer.send(order.customer.email, f"Total {total}")

# after
def process_order(order):
    total = order_total(order)
    db.save(order, total)
    notify_customer(order.customer, total)

def order_total(order):
    subtotal = sum(i.price * i.qty for i in order.items)
    return apply_tax(apply_discount(subtotal, order.customer.tier))
```

## 2. Deep nesting
Move: **Replace Nested Conditional with Guard Clauses**; extract inner blocks; invert conditions.
```ts
// before
function price(user, item) {
  if (user) {
    if (user.active) {
      if (item.inStock) { return item.price * (1 - user.discount); }
    }
  }
  return null;
}
// after
function price(user, item) {
  if (!user?.active) return null;
  if (!item.inStock) return null;
  return item.price * (1 - user.discount);
}
```

## 3. Long parameter list and data clumps
Move: **Introduce Parameter Object**; **Preserve Whole Object**. If the same 3+ values travel together, they are a concept: give them a type.
```ts
// before: createUser(name, email, street, city, zip, country)
// after:  createUser(profile: Profile, address: Address)
```

## 4. Boolean flag parameters
Hurts: call sites are unreadable (`save(x, true, false)`), and the function does two things.
Move: **Split into two functions**, or use a named options object or enum.
```python
# before: render(page, True)
# after:  render_preview(page)   /   render_final(page)
```

## 5. Primitive obsession
Move: **Replace Primitive with Value Object** (validated, immutable, with behavior). Use branded/newtype types to stop mixing ids.
```ts
type UserId = string & { readonly __brand: "UserId" };
class Money { constructor(readonly cents: number, readonly currency: "USD" | "EUR") {}
  add(o: Money) { if (o.currency !== this.currency) throw new Error("currency mismatch"); return new Money(this.cents + o.cents, this.currency); } }
```

## 6. Repeated conditionals on type
Hurts: every new type edits every switch (shotgun surgery).
Move: **Replace Conditional with Polymorphism**, a strategy, or a lookup table.
```python
# before
if kind == "csv": return to_csv(rows)
elif kind == "json": return to_json(rows)
elif kind == "xml": return to_xml(rows)
# after
EXPORTERS = {"csv": to_csv, "json": to_json, "xml": to_xml}
def export(kind, rows):
    try: return EXPORTERS[kind](rows)
    except KeyError: raise ValueError(f"unknown format: {kind}")
```
For closed sets in TypeScript prefer a discriminated union plus exhaustive `switch` with a `never` check.

## 7. Feature envy and Demeter violations
Hurts: a method uses another object's data more than its own; `a.getB().getC().doX()` couples callers to structure.
Move: **Move Method** to the class that owns the data; **Hide Delegate**; tell, do not ask.
```ts
// before: if (order.customer.address.country === "EG") ...
// after:  if (order.shipsTo("EG")) ...
```

## 8. Magic numbers and strings
Move: **Replace Magic Literal with Named Constant** or enum; keep constants near their use, or config if operators change them.
```python
# before: if retries > 3: sleep(0.5 * 2**retries)
MAX_RETRIES = 3
BACKOFF_BASE_S = 0.5
```

## 9. Duplicated logic
Move: **Extract Function/Module**, **Pull Up**, **Form Template Method**. Confirm the duplicates change for the *same reason* before merging; otherwise leave them.
Rule of three. Watch for the wrong abstraction: if the shared function grows flags and `if` branches per caller, inline it back and re-split.

## 10. God class or module
Hurts: everything depends on it; it changes for every feature; impossible to test.
Move: **Extract Class/Module** along responsibility seams (who asks for changes); introduce a facade if the old API must remain; migrate callers incrementally (strangler approach).

## 11. Shotgun surgery and divergent change
- *Shotgun surgery* (one change edits many files): **Move Function/Field** to consolidate the concept.
- *Divergent change* (one file changes for many reasons): **Split Phase**, **Extract Class**.

## 12. Mutable shared state and temporal coupling
Hurts: order-dependent bugs (`init()` must be called before `run()`), races, action at a distance.
Move: make objects valid on construction (constructor injection, factory); prefer immutability (`readonly`, `frozen=True` dataclasses, `Object.freeze`, immutable collections); pass state explicitly; avoid module-level mutable singletons.
```python
@dataclass(frozen=True)
class Config: url: str; timeout_s: float = 5.0
```

## 13. Dead code and speculative generality
Move: **Remove Dead Code** (unused functions, params, flags, feature toggles long since permanent, commented-out blocks); **Collapse Hierarchy**; **Inline Class**. Use coverage, usage search, and tools like `vulture`, `knip`, `ts-prune`, `deadcode`.

## 14. Error-handling smells
- Empty or catch-all handlers: catch specific errors; log with context or rethrow.
- Returning error codes mixed with data: use exceptions or a `Result` type consistently.
- Stringly-typed errors: define error classes/codes.
- Losing the cause: chain (`raise X from e`, `new Error(msg, { cause: e })`).
- Retrying non-idempotent work blindly.
```python
# before
try: data = load(path)
except: data = {}
# after
try: data = load(path)
except FileNotFoundError: data = {}          # expected, documented
except json.JSONDecodeError as e: raise ConfigError(f"{path}: invalid JSON") from e
```

## 15. Comment smells
- Comment explains confusing code: **rename/extract** instead.
- Outdated comments: delete or fix.
- Journal or author comments: version control does this.
- Section banners in long files: split the file.

## 16. Mechanics checklist
- [ ] Tests green before starting
- [ ] Single named refactoring per step
- [ ] Tests green after every step
- [ ] No behavior change hidden inside the refactor commit
- [ ] Public API changes noted and callers updated in the same change
- [ ] Renames done with tool support, then grep for string references (configs, docs, dynamic access)
- [ ] Performance-sensitive paths re-measured if the structure changed
