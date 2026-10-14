// Add account: inline similar-account confirmation (D-45, US-13.8).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { newMock } from '../../data/mock/testFile';

beforeEach(() => { document.body.style.overflow = ''; });
afterEach(() => cleanup());

async function openNew(ds = newMock()) {
  window.history.pushState({}, '', '/accounts?account=new');
  const user = userEvent.setup();
  render(<App ds={ds} />);
  const drawer = await screen.findByRole('dialog', { name: 'New account' });
  return { user, ds, drawer };
}
const panel = () => screen.getByRole('region', { name: /Similar account/ });

describe('Add account similar-account panel', () => {
  it('a near-duplicate name shows the existing account, reasons and a strength word; nothing is created yet', async () => {
    const { user, ds, drawer } = await openNew();
    const before = (await ds.getState()).accounts.length;
    await user.type(within(drawer).getByLabelText(/Account name/), 'Halvorsen Fjord Asset Mgmt');
    await user.click(within(drawer).getByRole('button', { name: 'Save account' }));
    const p = await screen.findByRole('region', { name: /Similar account found: Halvorsen Fjord Asset Management/ });
    expect(within(p).getByText('High match')).toBeInTheDocument();
    expect(within(p).getByText(/Same words, spelled differently/)).toBeInTheDocument();
    expect(within(p).getByRole('button', { name: 'Same account' })).toBeInTheDocument();
    expect(within(p).getByRole('button', { name: 'Different account' })).toBeInTheDocument();
    expect(within(p).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(p.textContent).not.toMatch(/\d\s?%|similarity|score/i);
    expect(within(drawer).getByRole('button', { name: 'Save account' })).toBeDisabled(); // choose one of the options first
    expect((await ds.getState()).accounts).toHaveLength(before);
    expect(p.querySelector('#similar-title')).toHaveFocus();
  });

  it('Same account opens the existing account, discards the typed values and writes nothing', async () => {
    const { user, ds, drawer } = await openNew();
    const before = (await ds.getState()).accounts;
    await user.type(within(drawer).getByLabelText(/Account name/), 'Halvorsen Fjord Asset Mgmt');
    await user.click(within(drawer).getByRole('button', { name: 'Save account' }));
    await user.click(within(await screen.findByRole('region', { name: /Similar account/ })).getByRole('button', { name: 'Same account' }));
    const hfa = before.find((a) => a.name === 'Halvorsen Fjord Asset Management')!;
    await waitFor(() => expect(window.location.pathname).toBe(`/accounts/${hfa.id}/overview`));
    expect(screen.queryByRole('dialog', { name: 'New account' })).toBeNull();
    const after = (await ds.getState()).accounts;
    expect(after).toHaveLength(before.length);
    expect(after.find((a) => a.id === hfa.id)!.row_version).toBe(hfa.row_version);
  });

  it('Different account creates it with duplicates_confirmed', async () => {
    const { user, ds, drawer } = await openNew();
    const spy = vi.spyOn(ds, 'saveAccount');
    await user.type(within(drawer).getByLabelText(/Account name/), 'Halvorsen Fjord Asset Mgmt');
    await user.click(within(drawer).getByRole('button', { name: 'Save account' }));
    await user.click(within(await screen.findByRole('region', { name: /Similar account/ })).getByRole('button', { name: 'Different account' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({ name: 'Halvorsen Fjord Asset Mgmt', duplicates_confirmed: true });
    await waitFor(() => expect((window.location.pathname)).toMatch(/^\/accounts\/[^/]+\/overview$/));
    expect((await ds.getState()).accounts.some((a) => a.name === 'Halvorsen Fjord Asset Mgmt')).toBe(true);
  });

  it('Cancel returns to the form with the typed values intact and focus on the name', async () => {
    const { user, ds, drawer } = await openNew();
    const before = (await ds.getState()).accounts.length;
    await user.type(within(drawer).getByLabelText(/Account name/), 'Halvorsen Fjord Asset Mgmt');
    await user.type(within(drawer).getByLabelText('BPID'), '77');
    await user.click(within(drawer).getByRole('button', { name: 'Save account' }));
    await user.click(within(await screen.findByRole('region', { name: /Similar account/ })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: /Similar account/ })).toBeNull();
    expect(within(drawer).getByLabelText(/Account name/)).toHaveValue('Halvorsen Fjord Asset Mgmt');
    expect(within(drawer).getByLabelText('BPID')).toHaveValue('77');
    await waitFor(() => expect(within(drawer).getByLabelText(/Account name/)).toHaveFocus());
    expect((await ds.getState()).accounts).toHaveLength(before);
  });

  it('an exact (case-insensitive) match offers only Same account and Cancel', async () => {
    const { user, drawer } = await openNew();
    await user.type(within(drawer).getByLabelText(/Account name/), 'castellan PEAK global markets');
    await user.click(within(drawer).getByRole('button', { name: 'Save account' }));
    const p = await screen.findByRole('region', { name: /already exists/ });
    expect(within(p).getByRole('button', { name: 'Same account' })).toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: 'Different account' })).toBeNull();
    expect(within(p).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('a name with no similar account is created directly, as before', async () => {
    const { user, ds, drawer } = await openNew();
    await user.type(within(drawer).getByLabelText(/Account name/), 'Zzyzx Unique Holdings');
    await user.click(within(drawer).getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/accounts\/[^/]+\/overview$/));
    expect((await ds.getState()).accounts.some((a) => a.name === 'Zzyzx Unique Holdings')).toBe(true);
  });

  it('leaving the name field checks too (blur shows the panel without stealing focus); editing the name hides it', async () => {
    const { user, drawer } = await openNew();
    const name = within(drawer).getByLabelText(/Account name/);
    await user.type(name, 'Halvorsen Fjord Asset Mgmt');
    await user.click(within(drawer).getByLabelText('BPID')); // moves focus away from the name
    await screen.findByRole('region', { name: /Similar account/ });
    expect(panel().querySelector('#similar-title')).not.toHaveFocus();
    await user.type(name, 'x');
    expect(screen.queryByRole('region', { name: /Similar account/ })).toBeNull();
  });

  it('if the server answers possible_duplicate at save time (race), the panel is shown from details.candidates', async () => {
    const ds = newMock();
    const real = ds.checkSimilarAccount.bind(ds);
    vi.spyOn(ds, 'checkSimilarAccount').mockResolvedValue({ exact: null, candidates: [] });
    const { user, drawer } = await openNew(ds);
    void real;
    await user.type(within(drawer).getByLabelText(/Account name/), 'Halvorsen Fjord Asset Mgmt');
    await user.click(within(drawer).getByRole('button', { name: 'Save account' }));
    expect(await screen.findByRole('region', { name: /Similar account found/ })).toBeInTheDocument();
    expect((await ds.getState()).accounts.some((a) => a.name === 'Halvorsen Fjord Asset Mgmt')).toBe(false);
  });
});
