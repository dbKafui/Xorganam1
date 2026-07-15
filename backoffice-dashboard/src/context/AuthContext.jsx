import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { authApi } from '../api/auth'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('xorganam_user')
    return stored ? JSON.parse(stored) : null
  })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('xorganam_token')
    if (!token) {
      setReady(true)
      return
    }
    authApi
      .me()
      .then((profile) => {
        if (!profile.isPlatformAdmin) {
          localStorage.removeItem('xorganam_token')
          localStorage.removeItem('xorganam_user')
          setUser(null)
          return
        }
        setUser(profile)
        localStorage.setItem('xorganam_user', JSON.stringify(profile))
      })
      .catch(() => {
        localStorage.removeItem('xorganam_token')
        localStorage.removeItem('xorganam_user')
        setUser(null)
      })
      .finally(() => setReady(true))
  }, [])

  const login = useCallback(async (email, password) => {
    const result = await authApi.login(email, password)

    if (!result.user.isPlatformAdmin) {
      throw new Error(
        "This account is an Operator account. Please use the XORGANAM checkout app's Operator portal instead of the Backoffice dashboard."
      )
    }

    localStorage.setItem('xorganam_token', result.token)
    localStorage.setItem('xorganam_user', JSON.stringify(result.user))
    setUser(result.user)
    return result.user
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('xorganam_token')
    localStorage.removeItem('xorganam_user')
    setUser(null)
    window.location.href = '/login'
  }, [])

  return (
    <AuthContext.Provider value={{ user, ready, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
