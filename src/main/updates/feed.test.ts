import { describe, expect, it } from 'vitest'
import { GITHUB_FEED, resolveFeed } from './feed'

describe('the GitHub feed', () => {
  it('reads the latest release of the Cubex repository', () => {
    expect(GITHUB_FEED.url).toBe('https://api.github.com/repos/HeshamXOR/Cubex/releases/latest')
    expect(GITHUB_FEED.origin).toBe('https://github.com')
    expect(GITHUB_FEED.pagePrefix).toBe('/HeshamXOR/Cubex/')
    expect(GITHUB_FEED.downloadPrefix).toBe('/HeshamXOR/Cubex/releases/download/')
    expect(GITHUB_FEED.local).toBe(false)
  })

  it.each(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'])('lets a download go to %s', (host) => {
    expect(GITHUB_FEED.allowsHost(host)).toBe(true)
  })

  it.each([
    'api.github.com', 'githubusercontent.com', 'evilgithubusercontent.com', 'github.com.evil.example', 'github.com:8443',
    'example.com', '127.0.0.1', 'githubusercontent.com.evil.example', ''
  ])('refuses to send a download to %j', (host) => {
    expect(GITHUB_FEED.allowsHost(host)).toBe(false)
  })
})

describe('resolveFeed', () => {
  it('uses GitHub unless it is given an address on this computer', () => {
    expect(resolveFeed(undefined)).toBe(GITHUB_FEED)
    expect(resolveFeed('')).toBe(GITHUB_FEED)
    expect(resolveFeed('   ')).toBe(GITHUB_FEED)
  })

  it.each([
    'http://127.0.0.1:5050/latest.json',
    'http://localhost:8080/api/latest',
    'https://localhost:9443/latest.json',
    'http://[::1]:7000/latest.json'
  ])('takes %s as a local feed that trusts only its own server', (address) => {
    const feed = resolveFeed(address)
    const url = new URL(address)
    expect(feed.local).toBe(true)
    expect(feed.url).toBe(url.href)
    expect(feed.origin).toBe(url.origin)
    expect(feed.pagePrefix).toBe('/')
    expect(feed.allowsHost(url.host)).toBe(true)
    expect(feed.allowsHost('github.com')).toBe(false)
    expect(feed.allowsHost(`${url.hostname}:1`)).toBe(false)
  })

  it.each([
    'http://192.168.1.5/latest.json',
    'http://example.com/latest.json',
    'https://github.com/HeshamXOR/Cubex/releases/latest',
    'http://127.0.0.1.evil.example/latest.json',
    'http://user:secret@127.0.0.1:5050/latest.json',
    'ftp://127.0.0.1/latest.json',
    'file:///C:/latest.json',
    'not an address'
  ])('ignores %s, so the variable cannot send a copy to another machine', (address) => {
    expect(resolveFeed(address)).toBe(GITHUB_FEED)
  })
})
